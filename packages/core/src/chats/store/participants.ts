import type {
	BotColor,
	MemberParticipant,
	Message,
	MessagePart,
	MessageReaction,
	MessageReplyTo,
	Participant,
} from "@sugabots/contracts";
import { handleFromName, messageStatusSchema, quotedPreview } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, inArray, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Schema } from "effect";
import type * as schema from "../../database/schema.ts";
import { bot, member, message, projectBot } from "../../database/schema.ts";
import { type AttachedFileRow, fileColumns, toFilePart } from "./file-parts.ts";
import type { PlacedPartsOf } from "./placed-parts.ts";
import { toToolCallPart } from "./tool-calls.ts";

/** The columns to select, left-joined from `member` and `bot`. */
export const participantColumns = {
	memberId: member.id,
	memberName: member.name,
	memberEmail: member.email,
	memberImage: member.image,
	botId: bot.id,
	botName: bot.name,
	botHandle: bot.handle,
	botColor: bot.color,
	botEyes: bot.eyes,
	botShape: bot.shape,
};

export interface ParticipantRow {
	memberId: string | null;
	memberName: string | null;
	memberEmail: string | null;
	memberImage: string | null;
	botId: string | null;
	botName: string | null;
	botHandle: string | null;
	botColor: BotColor | null;
	botEyes: schema.BotRow["eyes"] | null;
	botShape: schema.BotRow["shape"] | null;
}

export function toParticipant(row: ParticipantRow): Participant {
	if (row.memberId && row.memberName && row.memberEmail) {
		return toMember({
			id: row.memberId,
			name: row.memberName,
			email: row.memberEmail,
			image: row.memberImage,
		});
	}
	if (
		row.botId &&
		row.botName &&
		row.botHandle &&
		row.botColor !== null &&
		row.botEyes &&
		row.botShape
	) {
		return {
			kind: "bot",
			id: row.botId,
			name: row.botName,
			handle: row.botHandle,
			color: row.botColor,
			eyes: row.botEyes,
			shape: row.botShape,
		};
	}
	throw new Error("Participant has no identity");
}

/** A member as a message author, for rows where the author is known to be a member. */
export function memberAuthor(member: MemberIdentity): ParticipantRow {
	return authorRow(member, null);
}

/**
 * The API shape of a message row. `placed` are the tool calls
 * made in this message, from `loadPlacedParts`; a stored reference with no row
 * behind it is dropped rather than shown half-formed. `error` is shown only on
 * a failed reply.
 */
export function toMessage(
	row: schema.MessageRow,
	author: ParticipantRow,
	placed: PlacedPartsOf = {},
	/** What members are told of why the turn behind a failed reply failed. */
	error?: UserText | null,
): Message {
	const parts = row.parts.flatMap((part): MessagePart[] => {
		if (part.type === "text" || part.type === "written_file") {
			return [part];
		}
		const made = placed.toolCalls?.find((candidate) => candidate.id === part.toolCallId);
		return made ? [made] : [];
	});
	// Files are attached to the message rather than placed in its text, so they follow it.
	parts.push(...(placed.files ?? []));
	return {
		id: row.id,
		chatId: row.chatId,
		author: row.automationTrigger ?? toParticipant(author),
		status: Schema.decodeSync(messageStatusSchema)(row.status),
		parts,
		content: row.content,
		...(row.status === "failed" && error ? { error } : {}),
		createdAt: row.createdAt.toISOString(),
	};
}

/** A member's columns, for a relational query that names who wrote or joined. */
export const memberColumns = {
	columns: { id: true, name: true, email: true, image: true },
} as const;

/** A member as one JSON value, with the columns of {@link memberColumns}, for a SQL select over `member`. */
export const memberJson = sql<MemberIdentity>`json_build_object('id', ${member.id}, 'name', ${member.name}, 'email', ${member.email}, 'image', ${member.image})`;

/**
 * A member's id, name, email and image, for a select that names who did
 * something. Which member the query joins, and whether one who has left the
 * workspace is shown, is the query's to decide.
 */
export const namedMemberColumns = {
	id: member.id,
	name: member.name,
	email: member.email,
	image: member.image,
};

/** A member read with {@link memberColumns}, as the API shows them. */
export function toMember(row: MemberIdentity): MemberParticipant {
	return {
		kind: "member",
		id: row.id,
		name: row.name,
		email: row.email,
		handle: handleFromName(row.name),
		image: row.image,
	};
}

/** A bot's columns, for a relational query that names who wrote or joined. */
export const botColumns = {
	columns: { id: true, name: true, handle: true, color: true, eyes: true, shape: true },
} as const;

/** The columns and relations a relational query reads of a message a reply quotes. */
export const quotedMessageColumns = {
	columns: { id: true, content: true, parts: true, automationTrigger: true },
	with: { authorMember: memberColumns, authorBot: botColumns },
} as const;

/** A message read with {@link quotedMessageColumns}. */
interface QuotedMessage
	extends Pick<schema.MessageRow, "id" | "content" | "parts" | "automationTrigger"> {
	authorMember: MemberIdentity | null;
	authorBot: BotIdentity | null;
}

/** A quoted message as a reply shows it: who wrote it and its spoken text on one line. */
export function toReplyTo(quoted: QuotedMessage): MessageReplyTo {
	return {
		id: quoted.id,
		author:
			quoted.automationTrigger ?? toParticipant(authorRow(quoted.authorMember, quoted.authorBot)),
		preview: quotedPreview(quoted),
	};
}

/** `shown` with the message it quotes, when it quotes one. */
export function withReplyTo(shown: Message, replyTo: MessageReplyTo | undefined): Message {
	return replyTo ? { ...shown, replyTo } : shown;
}

/** The columns and relations a relational query reads of a message's reactions, earliest first. */
export const reactionColumns = {
	columns: { emoji: true, createdAt: true },
	orderBy: { createdAt: "asc", id: "asc" },
	with: {
		member: { columns: { id: true, name: true } },
		bot: { columns: { id: true, name: true } },
	},
} as const;

/** A reaction read with {@link reactionColumns}: a member's or a bot's. */
interface ReactionRow {
	emoji: string;
	createdAt: Date;
	member: { id: string; name: string } | null;
	bot: { id: string; name: string } | null;
}

/**
 * Reactions, earliest first, grouped by emoji in the order each was first
 * used, members' and bots' apart.
 */
export function toReactions(rows: readonly ReactionRow[]): MessageReaction[] {
	type Reactor = MessageReaction["members"][number];
	const byEmoji = new Map<string, { members: Reactor[]; bots: Reactor[] }>();
	for (const row of rows) {
		const reactor = row.member ?? row.bot;
		if (!reactor) continue;
		const reaction = byEmoji.get(row.emoji) ?? { members: [], bots: [] };
		byEmoji.set(row.emoji, reaction);
		(row.member ? reaction.members : reaction.bots).push({
			id: reactor.id,
			name: reactor.name,
			at: row.createdAt.toISOString(),
		});
	}
	return [...byEmoji].map(([emoji, { members, bots }]) => ({
		emoji,
		members,
		...(bots.length > 0 ? { bots } : {}),
	}));
}

/** The relations a relational query follows to read a message as the API shows it. */
export const messageRelations = {
	authorMember: memberColumns,
	authorBot: botColumns,
	toolCalls: {
		orderBy: { startedAt: "asc", id: "asc" },
		with: { decidedBy: { columns: { name: true } } },
	},
	files: { columns: fileColumns, orderBy: { position: "asc" } },
	automationRun: {
		columns: { id: true, chatId: true, automationId: true, automationName: true },
	},
	replyTo: quotedMessageColumns,
	reactions: reactionColumns,
} as const;

/** Who a member is, as read with {@link memberColumns}. */
export type MemberIdentity = { id: string; name: string; email: string; image: string | null };
type BotIdentity = Pick<schema.BotRow, "id" | "name" | "handle" | "color" | "eyes" | "shape">;

/** A message row read with `messageRelations`. */
interface MessageWithRelations extends schema.MessageRow {
	authorMember: MemberIdentity | null;
	authorBot: BotIdentity | null;
	toolCalls: Array<schema.ToolCallRow & { decidedBy: { name: string } | null }>;
	files: AttachedFileRow[];
	automationRun: Pick<schema.RunRow, "id" | "chatId" | "automationId" | "automationName"> | null;
	replyTo: QuotedMessage | null;
	reactions: ReactionRow[];
}

/** A message read with `messageRelations`, as the API shows it. */
export function messageFromRelations(
	stored: MessageWithRelations,
	/** The turn that wrote the reply: why it failed, if it did, and when it ended. */
	turn?: { error: UserText | null; finishedAt: Date | null } | null,
): Message {
	const shown = toMessage(
		stored,
		authorRow(stored.authorMember, stored.authorBot),
		{
			toolCalls: stored.toolCalls.map((call) => toToolCallPart(call, call.decidedBy?.name)),
			files: stored.files.map(toFilePart),
		},
		turn?.error,
	);
	const run = stored.automationRun;
	return {
		...shown,
		...(turn?.finishedAt ? { finishedAt: turn.finishedAt.toISOString() } : {}),
		...(run ? { automationResultOf: automationResultOf(run) } : {}),
		...(stored.replyTo ? { replyTo: toReplyTo(stored.replyTo) } : {}),
		...(stored.reactions.length > 0 ? { reactions: toReactions(stored.reactions) } : {}),
	};
}

/** The run `run` as the result posted from it links to it. */
export function automationResultOf(run: {
	id: string;
	chatId: string;
	automationId: string;
	automationName: string;
}): NonNullable<Message["automationResultOf"]> {
	return {
		runId: run.id,
		chatId: run.chatId,
		automationId: run.automationId,
		automationName: run.automationName,
	};
}

/** Whoever a relational query found, as the row `toParticipant` reads. */
export function authorRow(
	member: MemberIdentity | null,
	author: BotIdentity | null,
): ParticipantRow {
	return {
		memberId: member?.id ?? null,
		memberName: member?.name ?? null,
		memberEmail: member?.email ?? null,
		memberImage: member?.image ?? null,
		botId: author?.id ?? null,
		botName: author?.name ?? null,
		botHandle: author?.handle ?? null,
		botColor: author?.color ?? null,
		botEyes: author?.eyes ?? null,
		botShape: author?.shape ?? null,
	};
}

/** However quiet a chat is, its latest messages still count as recent. */
const RECENT_MESSAGE_COUNT = 100;
const RECENT_ACTIVITY_WINDOW = sql`interval '7 days'`;

/**
 * Who has written in a chat lately, most recently active first, as a scalar
 * subquery of participant rows: the authors of its last week of messages, or of
 * its last 100 when that reaches further back. An automation's trigger is not
 * somebody, so its messages are not counted.
 */
export const recentParticipantsOf = (chatId: SQLWrapper) => sql<ParticipantRow[]>`(
	select coalesce(json_agg(json_build_object(
		'memberId', recent.member_id, 'memberName', recent.member_name, 'memberEmail', recent.member_email,
		'memberImage', recent.member_image,
		'botId', recent.bot_id, 'botName', recent.bot_name, 'botHandle', recent.bot_handle,
		'botColor', recent.bot_color, 'botEyes', recent.bot_eyes,
		'botShape', recent.bot_shape
	) order by recent.last_active_at desc), '[]'::json)
	from (
		select ${member.id} as member_id, ${member.name} as member_name, ${member.email} as member_email,
			${member.image} as member_image,
			${bot.id} as bot_id, ${bot.name} as bot_name, ${bot.handle} as bot_handle,
			${bot.color} as bot_color, ${bot.eyes} as bot_eyes, ${bot.shape} as bot_shape,
			max(${message.createdAt}) as last_active_at
		from ${message}
		left join ${member} on ${member.id} = ${message.authorMemberId}
		left join ${bot} on ${bot.id} = ${message.authorBotId}
		where ${message.chatId} = ${chatId}
			and (${message.authorMemberId} is not null or ${message.authorBotId} is not null)
			and ${message.createdAt} >= least(
				coalesce((
					select latest.created_at from ${message} as latest
					where latest.chat_id = ${chatId}
					order by latest.created_at desc, latest.id desc
					offset ${RECENT_MESSAGE_COUNT - 1} limit 1
				), '-infinity'::timestamptz),
				now() - ${RECENT_ACTIVITY_WINDOW}
			)
		group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
	) as recent
)`;

/** The condition on `bot` that selects the bots added to the project `projectId`. */
export const inProject = (projectId: SQLWrapper | string) =>
	inArray(
		bot.id,
		sql`(select ${projectBot.botId} from ${projectBot} where ${projectBot.projectId} = ${projectId})`,
	);

/**
 * The condition on `bot` that selects bots members make: not a system bot,
 * such as Compaction, and not anybody's Personal Assistant.
 */
export const madeByMembers = and(isNull(bot.systemBotKey), isNull(bot.assistantOf)) as SQL;
