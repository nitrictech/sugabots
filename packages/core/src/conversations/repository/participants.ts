import type {
	BotColor,
	Message,
	MessagePart,
	MessageReaction,
	MessageReplyTo,
	Participant,
	PersonParticipant,
} from "@sugabots/contracts";
import { handleFromName, messageStatusSchema, quotedPreview } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, inArray, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Schema } from "effect";
import type * as schema from "../../database/schema.ts";
import { bot, message, projectBot, user } from "../../database/schema.ts";
import { toCollaborationPart } from "./collaboration-parts.ts";
import { type AttachedFileRow, fileColumns, toFilePart } from "./file-parts.ts";
import type { PlacedPartsOf } from "./placed-parts.ts";
import { toToolCallPart } from "./tool-calls.ts";

/** The columns to select, left-joined from `user` and `bot`. */
export const participantColumns = {
	userId: user.id,
	userName: user.name,
	userEmail: user.email,
	userImage: user.image,
	botId: bot.id,
	botName: bot.name,
	botHandle: bot.handle,
	botColor: bot.color,
	botFace: bot.face,
	botShape: bot.shape,
};

export interface ParticipantRow {
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	userImage: string | null;
	botId: string | null;
	botName: string | null;
	botHandle: string | null;
	botColor: BotColor | null;
	botFace: schema.BotRow["face"] | null;
	botShape: schema.BotRow["shape"] | null;
}

export function toParticipant(row: ParticipantRow): Participant {
	if (row.userId && row.userName && row.userEmail) {
		return toPerson({
			id: row.userId,
			name: row.userName,
			email: row.userEmail,
			image: row.userImage,
		});
	}
	if (
		row.botId &&
		row.botName &&
		row.botHandle &&
		row.botColor !== null &&
		row.botFace &&
		row.botShape
	) {
		return {
			kind: "bot",
			id: row.botId,
			name: row.botName,
			handle: row.botHandle,
			color: row.botColor,
			face: row.botFace,
			shape: row.botShape,
		};
	}
	throw new Error("Participant has no identity");
}

/** A person as a message author, for rows where the author is known to be a user. */
export function personAuthor(person: PersonIdentity): ParticipantRow {
	return authorRow(person, null);
}

/**
 * The API shape of a message row. `placed` are the collaborations and tool calls
 * made in this message, from `loadPlacedParts`; a stored reference with no row
 * behind it is dropped rather than shown half-formed. `error` is shown only on
 * a failed reply.
 */
export function toMessage(
	row: schema.MessageRow,
	author: ParticipantRow,
	placed: PlacedPartsOf = {},
	/** What people are told of why the turn behind a failed reply failed. */
	error?: UserText | null,
): Message {
	const parts = row.parts.flatMap((part): MessagePart[] => {
		if (part.type === "text" || part.type === "written_file") {
			return [part];
		}
		const made =
			part.type === "collaboration"
				? placed.collaborations?.find((candidate) => candidate.id === part.collaborationId)
				: placed.toolCalls?.find((candidate) => candidate.id === part.toolCallId);
		return made ? [made] : [];
	});
	// Files are attached to the message rather than placed in its text, so they follow it.
	parts.push(...(placed.files ?? []));
	return {
		id: row.id,
		conversationId: row.conversationId,
		author: row.automationTrigger ?? toParticipant(author),
		kind: row.kind,
		status: Schema.decodeSync(messageStatusSchema)(row.status),
		parts,
		content: row.content,
		...(row.status === "failed" && error ? { error } : {}),
		createdAt: row.createdAt.toISOString(),
	};
}

/** A person's columns, for a relational query that names who wrote or joined. */
export const personColumns = {
	columns: { id: true, name: true, email: true, image: true },
} as const;

/** A person as one JSON value, with the columns of {@link personColumns}, for a SQL select over `user`. */
export const personJson = sql<PersonIdentity>`json_build_object('id', ${user.id}, 'name', ${user.name}, 'email', ${user.email}, 'image', ${user.image})`;

/**
 * A person's id, name, email and image, for a select that names who did
 * something. Which person the query joins, and whether one who has left the
 * workspace is shown, is the query's to decide.
 */
export const namedPersonColumns = {
	id: user.id,
	name: user.name,
	email: user.email,
	image: user.image,
};

/** A person read with {@link personColumns}, as the API shows them. */
export function toPerson(row: PersonIdentity): PersonParticipant {
	return {
		kind: "person",
		id: row.id,
		name: row.name,
		email: row.email,
		handle: handleFromName(row.name),
		image: row.image,
	};
}

/** A bot's columns, for a relational query that names who wrote or joined. */
export const botColumns = {
	columns: { id: true, name: true, handle: true, color: true, face: true, shape: true },
} as const;

/** The columns and relations a relational query reads of a message a reply quotes. */
export const quotedMessageColumns = {
	columns: { id: true, content: true, parts: true, automationTrigger: true },
	with: { authorUser: personColumns, authorBot: botColumns },
} as const;

/** A message read with {@link quotedMessageColumns}. */
interface QuotedMessage
	extends Pick<schema.MessageRow, "id" | "content" | "parts" | "automationTrigger"> {
	authorUser: PersonIdentity | null;
	authorBot: BotIdentity | null;
}

/** A quoted message as a reply shows it: who wrote it and its spoken text on one line. */
export function toReplyTo(quoted: QuotedMessage): MessageReplyTo {
	return {
		id: quoted.id,
		author:
			quoted.automationTrigger ?? toParticipant(authorRow(quoted.authorUser, quoted.authorBot)),
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
	with: { user: { columns: { id: true, name: true } }, bot: { columns: { id: true, name: true } } },
} as const;

/** A reaction read with {@link reactionColumns}: a person's or a bot's. */
interface ReactionRow {
	emoji: string;
	createdAt: Date;
	user: { id: string; name: string } | null;
	bot: { id: string; name: string } | null;
}

/**
 * Reactions, earliest first, grouped by emoji in the order each was first
 * used, people's and bots' apart.
 */
export function toReactions(rows: readonly ReactionRow[]): MessageReaction[] {
	type Reactor = MessageReaction["people"][number];
	const byEmoji = new Map<string, { people: Reactor[]; bots: Reactor[] }>();
	for (const row of rows) {
		const reactor = row.user ?? row.bot;
		if (!reactor) continue;
		const reaction = byEmoji.get(row.emoji) ?? { people: [], bots: [] };
		byEmoji.set(row.emoji, reaction);
		(row.user ? reaction.people : reaction.bots).push({
			id: reactor.id,
			name: reactor.name,
			at: row.createdAt.toISOString(),
		});
	}
	return [...byEmoji].map(([emoji, { people, bots }]) => ({
		emoji,
		people,
		...(bots.length > 0 ? { bots } : {}),
	}));
}

/** The relations a relational query follows to read a message as the API shows it. */
export const messageRelations = {
	authorUser: personColumns,
	authorBot: botColumns,
	toolCalls: {
		orderBy: { startedAt: "asc", id: "asc" },
		with: { decidedBy: { columns: { name: true } } },
	},
	collaborations: { with: { collaborator: { columns: { name: true } } } },
	files: { columns: fileColumns, orderBy: { position: "asc" } },
	automationRun: {
		columns: { id: true, conversationId: true, automationId: true, automationName: true },
	},
	replyTo: quotedMessageColumns,
	reactions: reactionColumns,
} as const;

/** Who a person is, as read with {@link personColumns}. */
export type PersonIdentity = { id: string; name: string; email: string; image: string | null };
type BotIdentity = Pick<schema.BotRow, "id" | "name" | "handle" | "color" | "face" | "shape">;

/** A message row read with `messageRelations`. */
interface MessageWithRelations extends schema.MessageRow {
	authorUser: PersonIdentity | null;
	authorBot: BotIdentity | null;
	toolCalls: Array<schema.ToolCallRow & { decidedBy: { name: string } | null }>;
	collaborations: Array<schema.CollaborationRow & { collaborator: { name: string } }>;
	files: AttachedFileRow[];
	automationRun: Pick<
		schema.RunRow,
		"id" | "conversationId" | "automationId" | "automationName"
	> | null;
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
		authorRow(stored.authorUser, stored.authorBot),
		{
			toolCalls: stored.toolCalls.map((call) => toToolCallPart(call, call.decidedBy?.name)),
			collaborations: stored.collaborations.map((made) =>
				toCollaborationPart(made, made.collaborator.name),
			),
			files: stored.files.map(toFilePart),
		},
		turn?.error,
	);
	const run = stored.automationRun;
	return {
		...shown,
		...(turn?.finishedAt ? { finishedAt: turn.finishedAt.toISOString() } : {}),
		...(run
			? {
					automationResultOf: {
						runId: run.id,
						conversationId: run.conversationId,
						automationId: run.automationId,
						automationName: run.automationName,
					},
				}
			: {}),
		...(stored.replyTo ? { replyTo: toReplyTo(stored.replyTo) } : {}),
		...(stored.reactions.length > 0 ? { reactions: toReactions(stored.reactions) } : {}),
	};
}

/** Whoever a relational query found, as the row `toParticipant` reads. */
export function authorRow(
	person: PersonIdentity | null,
	author: BotIdentity | null,
): ParticipantRow {
	return {
		userId: person?.id ?? null,
		userName: person?.name ?? null,
		userEmail: person?.email ?? null,
		userImage: person?.image ?? null,
		botId: author?.id ?? null,
		botName: author?.name ?? null,
		botHandle: author?.handle ?? null,
		botColor: author?.color ?? null,
		botFace: author?.face ?? null,
		botShape: author?.shape ?? null,
	};
}

/** However quiet a conversation is, its latest messages still count as recent. */
const RECENT_MESSAGE_COUNT = 100;
const RECENT_ACTIVITY_WINDOW = sql`interval '7 days'`;

/**
 * Who has written in a conversation lately, most recently active first, as a scalar
 * subquery of participant rows: the authors of its last week of messages, or of
 * its last 100 when that reaches further back. An automation's trigger is not
 * somebody, so its messages are not counted.
 */
export const recentParticipantsOf = (conversationId: SQLWrapper) => sql<ParticipantRow[]>`(
	select coalesce(json_agg(json_build_object(
		'userId', recent.user_id, 'userName', recent.user_name, 'userEmail', recent.user_email,
		'userImage', recent.user_image,
		'botId', recent.bot_id, 'botName', recent.bot_name, 'botHandle', recent.bot_handle,
		'botColor', recent.bot_color, 'botFace', recent.bot_face,
		'botShape', recent.bot_shape
	) order by recent.last_active_at desc), '[]'::json)
	from (
		select ${user.id} as user_id, ${user.name} as user_name, ${user.email} as user_email,
			${user.image} as user_image,
			${bot.id} as bot_id, ${bot.name} as bot_name, ${bot.handle} as bot_handle,
			${bot.color} as bot_color, ${bot.face} as bot_face, ${bot.shape} as bot_shape,
			max(${message.createdAt}) as last_active_at
		from ${message}
		left join ${user} on ${user.id} = ${message.authorUserId}
		left join ${bot} on ${bot.id} = ${message.authorBotId}
		where ${message.conversationId} = ${conversationId}
			and (${message.authorUserId} is not null or ${message.authorBotId} is not null)
			and ${message.createdAt} >= least(
				coalesce((
					select latest.created_at from ${message} as latest
					where latest.conversation_id = ${conversationId}
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
 * The condition on `bot` that selects bots people make: not a system bot,
 * such as Compaction, and not anybody's Personal Assistant.
 */
export const madeByPeople = and(isNull(bot.systemBotKey), isNull(bot.assistantOf)) as SQL;
