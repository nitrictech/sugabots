import type {
	AgentColor,
	AgentParticipant,
	Message,
	MessagePart,
	MessageReaction,
	MessageReplyTo,
	PersonParticipant,
	ThreadParticipant,
} from "@sugabots/contracts";
import { handleFromName, messageStatusSchema, quotedPreview } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { eq, type SQLWrapper, sql } from "drizzle-orm";
import { Schema } from "effect";
import type * as schema from "../../database/schema.ts";
import { agent, message, user } from "../../database/schema.ts";
import { toCollaborationPart } from "./collaboration-parts.ts";
import { type AttachedFileRow, fileColumns, toFilePart } from "./file-parts.ts";
import type { PlacedPartsOf } from "./placed-parts.ts";
import { toToolCallPart } from "./tool-calls.ts";

/**
 * Turning joined rows into the API's people-and-agents shapes.
 *
 * A participant, and a message's author, is either a person or an agent. Both
 * are read by left-joining `user` and `agent` onto a row that has one of the
 * two ids, so every query that needs an author selects `participantColumns`
 * and hands the result to `toParticipant`.
 */

/** The columns to select, left-joined from `user` and `agent`. */
export const participantColumns = {
	userId: user.id,
	userName: user.name,
	userEmail: user.email,
	userImage: user.image,
	agentId: agent.id,
	agentName: agent.name,
	agentHandle: agent.handle,
	agentColor: agent.color,
	agentFace: agent.face,
	agentShape: agent.shape,
	agentExternal: sql<boolean>`${agent.a2aUrl} is not null`,
};

export interface ParticipantRow {
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	userImage: string | null;
	agentId: string | null;
	agentName: string | null;
	agentHandle: string | null;
	agentColor: AgentColor | null;
	agentFace: schema.AgentRow["face"] | null;
	agentShape: schema.AgentRow["shape"] | null;
	/** Whether the agent stands for an external agent; meaningless for a person. */
	agentExternal: boolean | null;
}

export function toParticipant(row: ParticipantRow): ThreadParticipant {
	if (row.userId && row.userName && row.userEmail) {
		return toPerson({
			id: row.userId,
			name: row.userName,
			email: row.userEmail,
			image: row.userImage,
		});
	}
	if (
		row.agentId &&
		row.agentName &&
		row.agentHandle &&
		row.agentColor !== null &&
		row.agentFace &&
		row.agentShape
	) {
		return {
			kind: "agent",
			id: row.agentId,
			name: row.agentName,
			handle: row.agentHandle,
			color: row.agentColor,
			face: row.agentFace,
			shape: row.agentShape,
			...(row.agentExternal ? { external: true } : {}),
		};
	}
	throw new Error("Thread participant has no identity");
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
		if (part.type === "text") {
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
		threadId: row.threadId,
		author: row.routineTrigger ?? toParticipant(author),
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

/** An agent's columns, for a relational query that names who wrote or joined. */
export const agentColumns = {
	columns: {
		id: true,
		name: true,
		handle: true,
		color: true,
		face: true,
		shape: true,
		a2aUrl: true,
	},
} as const;

/** An agent read with {@link agentColumns}, as the API shows it. */
export function toAgentParticipant({ a2aUrl, ...identity }: AgentIdentity): AgentParticipant {
	return { kind: "agent", ...identity, ...(a2aUrl !== null ? { external: true as const } : {}) };
}

/** The columns and relations a relational query reads of a message a reply quotes. */
export const quotedMessageColumns = {
	columns: { id: true, content: true, parts: true, routineTrigger: true },
	with: { authorUser: personColumns, authorAgent: agentColumns },
} as const;

/** A message read with {@link quotedMessageColumns}. */
export interface QuotedMessage
	extends Pick<schema.MessageRow, "id" | "content" | "parts" | "routineTrigger"> {
	authorUser: PersonIdentity | null;
	authorAgent: AgentIdentity | null;
}

/** A quoted message as a reply shows it: who wrote it and its spoken text on one line. */
export function toReplyTo(quoted: QuotedMessage): MessageReplyTo {
	return {
		id: quoted.id,
		author:
			quoted.routineTrigger ?? toParticipant(authorRow(quoted.authorUser, quoted.authorAgent)),
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
	with: { user: { columns: { id: true, name: true } } },
} as const;

/** A reaction read with {@link reactionColumns}. */
export interface ReactionRow {
	emoji: string;
	createdAt: Date;
	user: { id: string; name: string };
}

/** Reactions, earliest first, grouped by emoji in the order each was first used. */
export function toReactions(rows: readonly ReactionRow[]): MessageReaction[] {
	const byEmoji = new Map<string, MessageReaction>();
	for (const row of rows) {
		const person = { id: row.user.id, name: row.user.name, at: row.createdAt.toISOString() };
		const reaction = byEmoji.get(row.emoji);
		if (reaction) reaction.people.push(person);
		else byEmoji.set(row.emoji, { emoji: row.emoji, people: [person] });
	}
	return [...byEmoji.values()];
}

/** The relations a relational query follows to read a message as the API shows it. */
export const messageRelations = {
	authorUser: personColumns,
	authorAgent: agentColumns,
	toolCalls: {
		orderBy: { startedAt: "asc", id: "asc" },
		with: { decidedBy: { columns: { name: true } } },
	},
	collaborations: { with: { collaborator: { columns: { name: true } } } },
	files: { columns: fileColumns, orderBy: { position: "asc" } },
	routineExecution: { columns: { id: true, threadId: true, routineName: true } },
	replyTo: quotedMessageColumns,
	reactions: reactionColumns,
} as const;

/** Who a person is, as read with {@link personColumns}. */
export type PersonIdentity = { id: string; name: string; email: string; image: string | null };
type AgentIdentity = Pick<
	schema.AgentRow,
	"id" | "name" | "handle" | "color" | "face" | "shape" | "a2aUrl"
>;

/** A message row read with `messageRelations`. */
export interface MessageWithRelations extends schema.MessageRow {
	authorUser: PersonIdentity | null;
	authorAgent: AgentIdentity | null;
	toolCalls: Array<schema.ToolCallRow & { decidedBy: { name: string } | null }>;
	collaborations: Array<schema.CollaborationRow & { collaborator: { name: string } }>;
	files: AttachedFileRow[];
	routineExecution: Pick<schema.RoutineExecutionRow, "id" | "threadId" | "routineName"> | null;
	replyTo: QuotedMessage | null;
	reactions: ReactionRow[];
}

/** A message read with `messageRelations`, as the API shows it. */
export function messageFromRelations(
	stored: MessageWithRelations,
	/** What people are told of why the turn behind a failed reply failed. */
	error?: UserText | null,
): Message {
	const shown = toMessage(
		stored,
		authorRow(stored.authorUser, stored.authorAgent),
		{
			toolCalls: stored.toolCalls.map((call) => toToolCallPart(call, call.decidedBy?.name)),
			collaborations: stored.collaborations.map((made) =>
				toCollaborationPart(made, made.collaborator.name),
			),
			files: stored.files.map(toFilePart),
		},
		error,
	);
	const run = stored.routineExecution;
	return {
		...shown,
		...(run
			? {
					routineResultOf: {
						executionId: run.id,
						threadId: run.threadId,
						routineName: run.routineName,
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
	author: AgentIdentity | null,
): ParticipantRow {
	return {
		userId: person?.id ?? null,
		userName: person?.name ?? null,
		userEmail: person?.email ?? null,
		userImage: person?.image ?? null,
		agentId: author?.id ?? null,
		agentName: author?.name ?? null,
		agentHandle: author?.handle ?? null,
		agentColor: author?.color ?? null,
		agentFace: author?.face ?? null,
		agentShape: author?.shape ?? null,
		agentExternal: author ? author.a2aUrl !== null : null,
	};
}

/** However quiet a thread is, its latest messages still count as recent. */
const RECENT_MESSAGE_COUNT = 100;
const RECENT_ACTIVITY_WINDOW = sql`interval '7 days'`;

/**
 * Who has written in a thread lately, most recently active first, as a scalar
 * subquery of participant rows: the authors of its last week of messages, or of
 * its last 100 when that reaches further back. A routine's trigger is not
 * somebody, so its messages are not counted.
 */
export const recentParticipantsOf = (threadId: SQLWrapper) => sql<ParticipantRow[]>`(
	select coalesce(json_agg(json_build_object(
		'userId', recent.user_id, 'userName', recent.user_name, 'userEmail', recent.user_email,
		'userImage', recent.user_image,
		'agentId', recent.agent_id, 'agentName', recent.agent_name, 'agentHandle', recent.agent_handle,
		'agentColor', recent.agent_color, 'agentFace', recent.agent_face,
		'agentShape', recent.agent_shape, 'agentExternal', recent.agent_external
	) order by recent.last_active_at desc), '[]'::json)
	from (
		select ${user.id} as user_id, ${user.name} as user_name, ${user.email} as user_email,
			${user.image} as user_image,
			${agent.id} as agent_id, ${agent.name} as agent_name, ${agent.handle} as agent_handle,
			${agent.color} as agent_color, ${agent.face} as agent_face, ${agent.shape} as agent_shape,
			${agent.a2aUrl} is not null as agent_external,
			max(${message.createdAt}) as last_active_at
		from ${message}
		left join ${user} on ${user.id} = ${message.authorUserId}
		left join ${agent} on ${agent.id} = ${message.authorAgentId}
		where ${message.threadId} = ${threadId}
			and (${message.authorUserId} is not null or ${message.authorAgentId} is not null)
			and ${message.createdAt} >= least(
				coalesce((
					select latest.created_at from ${message} as latest
					where latest.thread_id = ${threadId}
					order by latest.created_at desc, latest.id desc
					offset ${RECENT_MESSAGE_COUNT - 1} limit 1
				), '-infinity'::timestamptz),
				now() - ${RECENT_ACTIVITY_WINDOW}
			)
		group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
	) as recent
)`;

/**
 * crewOf is the condition on `agent` that selects the crew of the pod `podId`:
 * every agent placed in it. `agent_placement_check` keeps system agents, a
 * Scribe or a Facilitator, out of pods, so they are never selected.
 */
export const crewOf = (podId: SQLWrapper | string) => eq(agent.podId, podId);
