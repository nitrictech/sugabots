import type { ToolApprovalDeciders, WorkspaceRole } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, getColumns, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { Executor } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	bot,
	channel,
	channelMember,
	directMessageMember,
	placedConversation,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import {
	type Actor,
	type BotFacts,
	type BotPermission,
	type ChannelFacts,
	type ChannelPermission,
	mayInChannel,
	mayOnBot,
	rolesGrantedInChannel,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * The facts every decision about who may do what is made from: the caller's
 * workspace role, and either the channel a resource is in and whether a
 * `channel_member` row puts them in it, or the bot it belongs to.
 * `Authorization` and `Visibility` load them here and decide with the pure
 * grants in `permissions.ts`; nothing else loads them or turns them into a
 * decision. Standings are only built in this module, so a caller cannot pair
 * a channel with somebody else's membership.
 *
 * **Reach** is a stored `channel_member` row for a channel; administrators are put
 * in every one by the triggers described on `channelMember`. A bot is reached by
 * everyone in the workspace when it is public, by its creator alone when it is
 * private, and by its person alone when it is a Personal Assistant. A task,
 * an automation's feed or one of its runs is reached through the bot it is
 * with. A collaboration is reached as the conversation it was opened from,
 * whichever bot was asked, so asking a private bot shows its answer to the
 * people of that conversation and nobody else. A direct message between people
 * is reached through a `direct_message_member` row while its person is in the
 * workspace, whatever their role. A system bot's conversation is reached by nobody.
 *
 * **Hidden** and **forbidden** are different refusals. A resource the caller
 * cannot reach is hidden, so an id cannot be probed for; a resource they can
 * reach but may not change is forbidden.
 */

/** The caller's standing in a workspace they belong to, so their role is known. */
export interface WorkspaceStanding {
	workspaceId: string;
	actor: Actor & { workspaceRole: WorkspaceRole };
}

/** The caller's standing towards a channel. */
export interface ChannelStanding {
	channel: schema.ChannelRow;
	actor: Actor;
	/** What the decision was made from, including whether a `channel_member` row exists. */
	facts: ChannelFacts;
	/** Whether the caller may also take `permission` on this same channel. */
	may(permission: ChannelPermission): boolean;
}

/** The caller's standing towards a bot. */
export interface BotStanding {
	bot: schema.BotRow;
	actor: Actor;
	facts: BotFacts;
	/** Whether the caller may take `permission` on this bot. */
	may(permission: BotPermission): boolean;
}

/**
 * The caller's standing towards a conversation they reach: a channel's
 * conversation by their standing in the channel, a bot's conversation by
 * their standing towards the bot, and a direct message, being in which
 * permits only reading it and writing in it. A collaboration's standing is
 * the one towards the conversation it was opened from: `channel` when that is a
 * channel's, else `bot` with the standing towards that conversation's bot,
 * not the bot that was asked.
 */
export type ConversationStanding =
	| { kind: "channel"; conversation: schema.PlacedConversationRow; standing: ChannelStanding }
	| { kind: "bot"; conversation: schema.PlacedConversationRow; standing: BotStanding }
	| { kind: "direct_message"; conversation: schema.PlacedConversationRow };

/**
 * The resource is not there, or the caller may not know that it is. Answered
 * as `not_found` over HTTP: telling the two apart lets a stranger enumerate
 * ids.
 */
export class ResourceHidden
	extends Data.TaggedError("ResourceHidden")<{
		readonly resource:
			| "workspace"
			| "channel"
			| "bot"
			| "conversation"
			| "automation"
			| "message"
			| "turn"
			| "member"
			| "invitation"
			| "file";
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`No such ${this.resource}`;
	}
}

/** The caller can see the resource and may not take this action on it. */
export class ActionForbidden
	extends Data.TaggedError("ActionForbidden")<{
		readonly permission: WorkspacePermission | ChannelPermission | BotPermission;
	}>
	implements UserFacing
{
	override get message() {
		return `Lacks the ${this.permission} permission`;
	}
	get userMessage() {
		return userText`You are not allowed to do that`;
	}
}

export type AuthorizationDenied = ResourceHidden | ActionForbidden;

/**
 * The standing, when there is one and its caller reaches the channel or bot;
 * otherwise `resource` is hidden, so a refusal never confirms an id.
 */
export function requireReach<Standing extends ChannelStanding | BotStanding>(
	standing: Standing | undefined,
	resource: ResourceHidden["resource"],
): Effect.Effect<Standing, ResourceHidden> {
	const reached =
		standing !== undefined &&
		("channel" in standing ? standing.may("channel.read") : standing.may("bot.read"));
	return reached ? Effect.succeed(standing) : Effect.fail(new ResourceHidden({ resource }));
}

/**
 * The standing of `actor` towards `row`, a channel they have just been put
 * in, by creating it or joining it: they are its member.
 */
export function joinedStanding(row: schema.ChannelRow, actor: Actor): ChannelStanding {
	return channelStanding(row, actor, true);
}

/** One person's standing towards one channel, from facts already in hand. */
function channelStanding(row: schema.ChannelRow, actor: Actor, isMember: boolean): ChannelStanding {
	const facts: ChannelFacts = { isMember };
	return {
		channel: row,
		actor,
		facts,
		may: (permission) => mayInChannel(actor, permission, facts),
	};
}

/** One person's standing towards one bot, from facts already in hand. */
export function botStanding(row: schema.BotRow, actor: Actor): BotStanding {
	const facts: BotFacts = {
		visibility: row.visibility,
		createdById: row.createdById,
		assistantOf: row.assistantOf,
	};
	return { bot: row, actor, facts, may: (permission) => mayOnBot(actor, permission, facts) };
}

/**
 * What a channel standing is built from, for a query that has `channel`: the
 * columns to select, and the two joins onto the caller's membership of the
 * workspace and of the channel. Left joins, so a channel the caller has no
 * part in is still found, with a standing that permits nothing.
 */
const standingColumns = {
	channel,
	role: workspaceMember.role,
	membershipId: channelMember.id,
};

const workspaceMembershipOf = (userId: string) =>
	and(eq(workspaceMember.workspaceId, channel.workspaceId), eq(workspaceMember.userId, userId));

const channelMembershipOf = (userId: string) =>
	and(eq(channelMember.channelId, channel.id), eq(channelMember.userId, userId));

type StandingRow = {
	channel: schema.ChannelRow;
	role: WorkspaceRole | null;
	membershipId: string | null;
};

function standingFromRow(row: StandingRow, userId: string): ChannelStanding {
	return channelStanding(
		row.channel,
		{ userId, workspaceRole: row.role ?? undefined },
		row.membershipId !== null,
	);
}

/**
 * The workspace `workspaceRef` names, by its id or its slug, and `userId`'s
 * role in it. `undefined` when there is no such workspace or they are not in
 * it, which are answered alike.
 */
export const workspaceStandingFor = Effect.fn("Access.workspaceStandingFor")(function* (
	db: Executor,
	workspaceRef: string,
	userId: string,
) {
	// A uuid is compared as an id, and anything else as a slug, so a malformed
	// id is never handed to Postgres as a uuid.
	const named = isUuid(workspaceRef)
		? eq(workspace.id, workspaceRef)
		: eq(workspace.slug, workspaceRef);
	const [row] = yield* db
		.select({ workspaceId: workspace.id, role: workspaceMember.role })
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(named, eq(workspaceMember.userId, userId)))
		.limit(1);
	return row
		? { workspaceId: row.workspaceId, actor: { userId, workspaceRole: row.role } }
		: undefined;
});

/**
 * Everything a decision about one channel needs, in one query: the channel,
 * the caller's workspace role and whether a `channel_member` row puts them in it.
 *
 * `undefined` only when there is no such channel. Somebody outside the
 * workspace gets a standing that permits nothing.
 */
export const channelStandingFor = Effect.fn("Access.channelStandingFor")(function* (
	db: Executor,
	channelId: string,
	userId: string,
) {
	if (!isUuid(channelId)) return undefined;
	const [row] = yield* db
		.select(standingColumns)
		.from(channel)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(channelMember, channelMembershipOf(userId))
		.where(eq(channel.id, channelId))
		.limit(1);
	return row ? standingFromRow(row, userId) : undefined;
});

/**
 * A bot and `userId`'s standing towards it, in one query. `undefined` when
 * there is no such bot, or it is a system bot, which nobody addresses.
 */
export const botStandingFor = Effect.fn("Access.botStandingFor")(function* (
	db: Executor,
	botId: string,
	userId: string,
) {
	if (!isUuid(botId)) return undefined;
	const [row] = yield* db
		.select({ bot, role: workspaceMember.role })
		.from(bot)
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, bot.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.where(and(eq(bot.id, botId), isNull(bot.systemBotKey)))
		.limit(1);
	return row ? botStanding(row.bot, { userId, workspaceRole: row.role ?? undefined }) : undefined;
});

/**
 * A conversation `userId` reaches, with their standing towards it, in one
 * query. `undefined` when there is no such conversation or they do not reach
 * it, which are answered alike.
 */
export const conversationStandingFor = Effect.fn("Access.conversationStandingFor")(function* (
	db: Executor,
	conversationId: string,
	userId: string,
) {
	if (!isUuid(conversationId)) return undefined;
	// A collaboration is reached through the conversation it was opened from,
	// so its channel and bot are that conversation's.
	const reachedThrough = alias(placedConversation, "reached_through");
	const reachChannelId = sql<
		string | null
	>`coalesce(${reachedThrough.channelId}, ${placedConversation.channelId})`;
	const reachBotId = sql<
		string | null
	>`case when ${reachedThrough.id} is null then ${placedConversation.botId} else ${reachedThrough.botId} end`;
	const [row] = yield* db
		.select({
			conversation: getColumns(placedConversation),
			channel,
			bot,
			role: workspaceMember.role,
			membershipId: channelMember.id,
			inDirectMessage: reachesDirectMessageFor(placedConversation, userId),
		})
		.from(placedConversation)
		.leftJoin(
			reachedThrough,
			and(
				eq(placedConversation.kind, "collaboration"),
				eq(reachedThrough.id, placedConversation.rootConversationId),
			),
		)
		.leftJoin(channel, eq(channel.id, reachChannelId))
		.leftJoin(bot, and(eq(bot.id, reachBotId), isNull(bot.systemBotKey)))
		.leftJoin(
			workspaceMember,
			and(
				eq(workspaceMember.workspaceId, placedConversation.workspaceId),
				eq(workspaceMember.userId, userId),
			),
		)
		.leftJoin(channelMember, channelMembershipOf(userId))
		.where(eq(placedConversation.id, conversationId))
		.limit(1);
	if (!row) return undefined;
	const actor: Actor = { userId, workspaceRole: row.role ?? undefined };
	if (row.channel) {
		const inChannel: ConversationStanding = {
			kind: "channel",
			conversation: row.conversation,
			standing: channelStanding(row.channel, actor, row.membershipId !== null),
		};
		return inChannel.standing.may("channel.read") ? inChannel : undefined;
	}
	if (row.bot) {
		const withBot: ConversationStanding = {
			kind: "bot",
			conversation: row.conversation,
			standing: botStanding(row.bot, actor),
		};
		return withBot.standing.may("bot.read") ? withBot : undefined;
	}
	if (row.conversation.kind !== "direct_message") return undefined;
	const direct: ConversationStanding = { kind: "direct_message", conversation: row.conversation };
	return row.inDirectMessage ? direct : undefined;
});

/**
 * The channels in a workspace that `userId` is in, by name, each with their
 * standing in it, in one query.
 */
export const reachedChannelStandingsFor = Effect.fn("Access.reachedChannelStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(channel)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(channelMember, channelMembershipOf(userId))
		.where(and(eq(channel.workspaceId, workspaceId), reachesChannelFor(channel.id, userId)))
		.orderBy(asc(channel.name));
	return rows.map((row) => standingFromRow(row, userId));
});

/**
 * The channels of a workspace `userId` is in or could join, by name, each with
 * their standing in it, in one query: the public ones, and the private ones
 * they are in.
 */
export const listedChannelStandingsFor = Effect.fn("Access.listedChannelStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(channel)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(channelMember, channelMembershipOf(userId))
		.where(
			and(
				eq(channel.workspaceId, workspaceId),
				sql`(${channel.visibility} = 'public' or ${channelMember.id} is not null)`,
			),
		)
		.orderBy(asc(channel.name));
	return rows.map((row) => standingFromRow(row, userId));
});

/**
 * The bots in a workspace `userId` is in, each with their standing towards
 * it, in one query: those they reach, and the private ones they don't, which
 * an administrator still manages. System bots are nobody's.
 */
export const botStandingsFor = Effect.fn("Access.botStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select({ bot, role: workspaceMember.role })
		.from(bot)
		.innerJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, bot.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.where(and(eq(bot.workspaceId, workspaceId), isNull(bot.systemBotKey)));
	return rows.map((row) => botStanding(row.bot, { userId, workspaceRole: row.role }));
});

/**
 * Whether a standing may decide a tool call's approval that `deciders`
 * decide. For `conversation`: `approval.decide`, and `approval.automation.decide` as
 * well for one raised while an automation runs. For `computer-managers`:
 * `computer.request.decide`, wherever it was raised.
 */
export function mayDecideApprovals(
	standing: {
		may(
			permission: "approval.decide" | "approval.automation.decide" | "computer.request.decide",
		): boolean;
	},
	inAutomation: boolean,
	deciders: ToolApprovalDeciders,
): boolean {
	if (deciders === "computer-managers") return standing.may("computer.request.decide");
	const needed = inAutomation
		? (["approval.decide", "approval.automation.decide"] as const)
		: (["approval.decide"] as const);
	return needed.every((permission) => standing.may(permission));
}

/**
 * Whether the caller, who reaches the conversation a tool call was raised in, may
 * decide it. A request to change a bot's computer is decided by the bot's
 * managers, or a Personal Assistant's person, wherever it was raised: `askingBot` is the caller's standing
 * towards the bot that raised the call, if they have one. Any other call is
 * decided by the conversation's people: in a channel's conversation by those holding
 * `approval.decide` there, and otherwise by those whose standing towards the
 * conversation's bot lets them, which for a collaboration is the bot of the
 * conversation it was opened from, whichever bot asked.
 */
export function mayDecideToolCall(
	reached: ConversationStanding,
	askingBot: BotStanding | undefined,
	inAutomation: boolean,
	deciders: ToolApprovalDeciders,
): boolean {
	if (deciders === "computer-managers") return askingBot?.may("computer.request.decide") ?? false;
	if (reached.kind === "channel") return reached.standing.may("approval.decide");
	if (reached.kind === "bot") return mayDecideApprovals(reached.standing, inAutomation, deciders);
	return false;
}

/**
 * SQL for "`userId` is in the channel `channelId` names", `userId` being an id or
 * the column holding one: what `mayInChannel(actor, "channel.read", …)` decides for
 * one channel, written again as a `where` clause. The roles come from
 * `rolesGrantedInChannel`, but the shape of the rule is repeated here, so a change
 * to `mayInChannel`'s shape must be made here too.
 *
 * Aliased throughout, so it composes with a query that already joins any of
 * these tables.
 */
export function reachesChannelFor(
	channelId: SQLWrapper,
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${channel} as reach_channel
		inner join ${workspaceMember} as reach_workspace_member
			on reach_workspace_member.workspace_id = reach_channel.workspace_id
			and reach_workspace_member.user_id = ${userId}
		inner join ${channelMember} as reach_channel_member
			on reach_channel_member.channel_id = reach_channel.id
			and reach_channel_member.user_id = ${userId}
		where reach_channel.id = ${channelId}
			and ${roleIsOneOf(ROLES_READING_CHANNELS)}
	)`;
}

/**
 * SQL for "`userId` reaches the bot `botId` names": what `reachesBot`
 * decides for one bot, written again as a `where` clause, so a change to it
 * must be made here too. System bots are reached by nobody.
 */
export function reachesBotFor(botId: SQLWrapper, userId: string | SQLWrapper): SQL<boolean> {
	return sql`exists (
		select 1
		from ${bot} as reach_bot
		inner join ${workspaceMember} as reach_bot_workspace_member
			on reach_bot_workspace_member.workspace_id = reach_bot.workspace_id
			and reach_bot_workspace_member.user_id = ${userId}
		where reach_bot.id = ${botId}
			and reach_bot.system_bot_key is null
			and case
				when reach_bot.assistant_of is not null then reach_bot.assistant_of = ${userId}
				when reach_bot.visibility = 'private' then reach_bot.created_by_id = ${userId}
				else true
			end
	)`;
}

/**
 * The columns of a placed conversation, or an alias of it, that whether
 * somebody reaches it is decided from.
 */
export interface ConversationReachColumns {
	id: SQLWrapper;
	workspaceId: SQLWrapper;
	kind: SQLWrapper;
	rootConversationId: SQLWrapper;
	channelId: SQLWrapper;
	botId: SQLWrapper;
}

/**
 * SQL for "`userId` reaches the conversation `row`": the channel rule for a
 * channel's conversation, the bot rule for a bot's conversation, the rule of
 * the conversation it was opened from for a collaboration, and membership of
 * the direct message for one between people. Written as SQL for lists, as
 * `conversationStandingFor` decides it for one conversation.
 */
export function reachesConversationFor(
	row: ConversationReachColumns,
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`(case when ${row.kind} = 'collaboration' then exists (
		select 1
		from ${placedConversation} as reach_opened_from
		where reach_opened_from.id = ${row.rootConversationId}
			and (${reachesChannelFor(sql`reach_opened_from.channel_id`, userId)}
				or ${reachesBotFor(sql`reach_opened_from.bot_id`, userId)})
	) else (${reachesChannelFor(row.channelId, userId)} or ${reachesBotFor(row.botId, userId)} or ${reachesDirectMessageFor(row, userId)}) end)`;
}

/**
 * SQL for "`userId` is in the direct message `row` and still in its
 * workspace". False for every other conversation, which has no
 * `direct_message_member` rows.
 */
function reachesDirectMessageFor(
	row: { id: SQLWrapper; workspaceId: SQLWrapper },
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${directMessageMember} as reach_direct_member
		inner join ${workspaceMember} as reach_direct_workspace_member
			on reach_direct_workspace_member.user_id = reach_direct_member.user_id
			and reach_direct_workspace_member.workspace_id = ${row.workspaceId}
		where reach_direct_member.conversation_id = ${row.id}
			and reach_direct_member.user_id = ${userId}
	)`;
}

/** Roles that reach a channel once they have been added to it. */
const ROLES_READING_CHANNELS = rolesGrantedInChannel("channel.read");

/** `false` rather than an empty `in ()`, which is not valid SQL. */
function roleIsOneOf(roles: readonly WorkspaceRole[]): SQL {
	if (roles.length === 0) return sql`false`;
	return sql`reach_workspace_member.role in (${sql.join(
		roles.map((role) => sql`${role}`),
		sql`, `,
	)})`;
}
