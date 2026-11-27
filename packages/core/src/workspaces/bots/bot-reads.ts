import {
	ADMINISTERING_WORKSPACE_ROLES,
	type Bot,
	type BotMember,
	type NamedMember,
	type SystemBot,
} from "@sugabots/contracts";
import { and, asc, eq, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import { Effect } from "effect";
import { botMemberIds, reachesBotFor } from "../../authorization/access.ts";
import { type Actor, managesEveryBot } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import { bot, botMember, member, membership, projectBot } from "../../database/schema.ts";
import { creatorOf, defaultProjectIdOf, memberFacingBotRow, pinnedBy, toBot } from "./bot.ts";
import { SYSTEM_BOTS } from "./system-bots.ts";

/**
 * The bots in a workspace that `actor` sees, by name: those they reach, and,
 * for an administrator, every personal bot too, Personal Assistants included,
 * which they see listed but can't open. Each says whether `actor` pinned it. System bots are not here.
 */
export const visibleMemberFacingBots = (workspaceId: string, actor: Actor) =>
	query((db) =>
		db
			.select(shownColumns(actor))
			.from(bot)
			.where(
				and(
					eq(bot.workspaceId, workspaceId),
					isNull(bot.systemBotKey),
					managesEveryBot(actor) ? undefined : reachesBotFor(bot.id, actor.memberId),
				),
			)
			.orderBy(asc(bot.name)),
	).pipe(Effect.map((rows): Bot[] => rows.flatMap((row) => shownTo(row, actor) ?? [])));

/** The bots in the project `projectId` as `actor` is shown them, by name. Whether `actor` reaches the project is the caller's to decide. */
export const projectBots = (projectId: string, actor: Actor) =>
	query((db) =>
		db
			.select(shownColumns(actor))
			.from(projectBot)
			.innerJoin(bot, eq(bot.id, projectBot.botId))
			.where(eq(projectBot.projectId, projectId))
			.orderBy(asc(bot.name)),
	).pipe(Effect.map((rows): Bot[] => rows.flatMap((row) => shownTo(row, actor) ?? [])));

/**
 * The bot `botId` as `actor` is shown it, with whether they pinned it, or
 * nothing for a system bot or one that is gone. Whether `actor` may see it is
 * the caller's to decide.
 */
export const memberFacingBot = (botId: string, actor: Actor) =>
	query((db) => db.select(shownColumns(actor)).from(bot).where(eq(bot.id, botId)).limit(1)).pipe(
		Effect.map(([row]) => (row ? shownTo(row, actor) : undefined)),
	);

/** The members of the private bot `botId`, by name. Any other bot has none. */
export const botMembers = (botId: string) =>
	query((db) =>
		db
			.select({
				memberId: member.id,
				name: member.name,
				email: member.email,
				image: member.image,
				removable: sql<boolean>`${not(inArray(membership.role, [...ADMINISTERING_WORKSPACE_ROLES]))}`,
			})
			.from(botMember)
			.innerJoin(member, eq(member.id, botMember.memberId))
			.innerJoin(
				membership,
				and(
					eq(membership.workspaceId, botMember.workspaceId),
					eq(membership.memberId, botMember.memberId),
					eq(membership.leaving, false),
				),
			)
			.where(eq(botMember.botId, botId))
			.orderBy(asc(member.name)),
	).pipe(Effect.map((rows): BotMember[] => rows));

/** What a bot is shown with: its row, whether `actor` pinned it, its members, its default project and who added it. */
const shownColumns = (actor: Actor) => ({
	bot,
	memberIds: botMemberIds(bot.id),
	pinned: pinnedBy(bot.id, actor.memberId),
	defaultProjectId: defaultProjectIdOf(bot.id),
	createdBy: creatorOf(bot),
});

function shownTo(
	row: {
		bot: typeof bot.$inferSelect;
		memberIds: string[];
		pinned: boolean;
		defaultProjectId: string;
		createdBy: NamedMember | null;
	},
	actor: Actor,
): Bot | undefined {
	const shown = memberFacingBotRow(row.bot);
	return (
		shown &&
		toBot(
			{
				...shown,
				memberIds: row.memberIds,
				defaultProjectId: row.defaultProjectId,
				createdBy: row.createdBy,
			},
			{ actor, pinned: row.pinned },
		)
	);
}

/**
 * Every system bot the product defines, with the model the workspace chose
 * for it. The name, avatar and order come from the definitions; a workspace
 * missing a row reads as one that has not set that bot up.
 */
export const systemBots = (workspaceId: string) =>
	query((db) =>
		db
			.select({ key: bot.systemBotKey, model: bot.model })
			.from(bot)
			.where(and(eq(bot.workspaceId, workspaceId), isNotNull(bot.systemBotKey))),
	).pipe(
		Effect.map((rows): SystemBot[] => {
			const modelOf = new Map(rows.map((row) => [row.key, row.model]));
			return SYSTEM_BOTS.map((definition) => ({
				key: definition.key,
				name: definition.name,
				description: definition.description,
				color: definition.color,
				eyes: definition.eyes,
				shape: definition.shape,
				model: modelOf.get(definition.key) ?? null,
			}));
		}),
	);
