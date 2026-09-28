import type { AgentColor, Message, MessagePart, ThreadParticipant } from "@sugabots/contracts";
import { handleFromName, messageStatusSchema } from "@sugabots/contracts";
import { asc, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { Executor } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agent, message, threadParticipant, user } from "../../database/schema.ts";
import type { UserMessage } from "../../user-message.ts";
import { toCollaborationPart } from "./collaborations.ts";
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
	userImage: user.image,
	agentId: agent.id,
	agentName: agent.name,
	agentHandle: agent.handle,
	agentColor: agent.color,
	agentFace: agent.face,
};

export interface ParticipantRow {
	userId: string | null;
	userName: string | null;
	userImage: string | null;
	agentId: string | null;
	agentName: string | null;
	agentHandle: string | null;
	agentColor: AgentColor | null;
	agentFace: schema.AgentRow["face"] | null;
}

export function toParticipant(row: ParticipantRow): ThreadParticipant {
	if (row.userId && row.userName) {
		return {
			kind: "person",
			id: row.userId,
			name: row.userName,
			handle: handleFromName(row.userName),
			image: row.userImage,
		};
	}
	if (row.agentId && row.agentName && row.agentHandle && row.agentColor !== null && row.agentFace) {
		return {
			kind: "agent",
			id: row.agentId,
			name: row.agentName,
			handle: row.agentHandle,
			color: row.agentColor,
			face: row.agentFace,
		};
	}
	throw new Error("Thread participant has no identity");
}

/** A person as a message author, for rows where the author is known to be a user. */
export function personAuthor(person: {
	userId: string;
	userName: string;
	userImage: string | null;
}): ParticipantRow {
	return {
		...person,
		agentId: null,
		agentName: null,
		agentHandle: null,
		agentColor: null,
		agentFace: null,
	};
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
	error?: UserMessage | null,
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
export const personColumns = { columns: { id: true, name: true, image: true } } as const;

/** An agent's columns, for a relational query that names who wrote or joined. */
export const agentColumns = {
	columns: { id: true, name: true, handle: true, color: true, face: true },
} as const;

/** The relations a relational query follows to read a message as the API shows it. */
export const messageRelations = {
	authorUser: personColumns,
	authorAgent: agentColumns,
	toolCalls: {
		orderBy: { startedAt: "asc", id: "asc" },
		with: { decidedBy: { columns: { name: true } } },
	},
	collaborations: { with: { collaborator: { columns: { name: true } } } },
} as const;

type PersonIdentity = { id: string; name: string; image: string | null };
type AgentIdentity = Pick<schema.AgentRow, "id" | "name" | "handle" | "color" | "face">;

/** A message row read with `messageRelations`. */
export interface MessageWithRelations extends schema.MessageRow {
	authorUser: PersonIdentity | null;
	authorAgent: AgentIdentity | null;
	toolCalls: Array<schema.ToolCallRow & { decidedBy: { name: string } | null }>;
	collaborations: Array<schema.CollaborationRow & { collaborator: { name: string } }>;
}

/** A message read with `messageRelations`, as the API shows it. */
export function messageFromRelations(
	stored: MessageWithRelations,
	/** What people are told of why the turn behind a failed reply failed. */
	error?: UserMessage | null,
): Message {
	return toMessage(
		stored,
		authorRow(stored.authorUser, stored.authorAgent),
		{
			toolCalls: stored.toolCalls.map((call) => toToolCallPart(call, call.decidedBy?.name)),
			collaborations: stored.collaborations.map((made) =>
				toCollaborationPart(made, made.collaborator.name),
			),
		},
		error,
	);
}

/** Whoever a relational query found, as the row `toParticipant` reads. */
export function authorRow(
	person: PersonIdentity | null,
	author: AgentIdentity | null,
): ParticipantRow {
	return {
		userId: person?.id ?? null,
		userName: person?.name ?? null,
		userImage: person?.image ?? null,
		agentId: author?.id ?? null,
		agentName: author?.name ?? null,
		agentHandle: author?.handle ?? null,
		agentColor: author?.color ?? null,
		agentFace: author?.face ?? null,
	};
}

/** Everyone in a thread, in the order they joined. */
export const loadParticipants = Effect.fn("Participants.loadParticipants")(function* (
	db: Executor,
	threadId: string,
) {
	const byThread = yield* loadParticipantsByThread(db, [threadId]);
	return byThread.get(threadId) ?? [];
});

/**
 * Everyone in each of these threads, in the order they joined, keyed by
 * thread id, in one query. A thread with no participants has no entry.
 */
export const loadParticipantsByThread = Effect.fn("Participants.loadParticipantsByThread")(
	function* (db: Executor, threadIds: readonly string[]) {
		const byThread = new Map<string, ThreadParticipant[]>();
		if (threadIds.length === 0) {
			return byThread;
		}
		const rows = yield* db
			.select({ threadId: threadParticipant.threadId, ...participantColumns })
			.from(threadParticipant)
			.leftJoin(user, eq(user.id, threadParticipant.userId))
			.leftJoin(agent, eq(agent.id, threadParticipant.agentId))
			.where(inArray(threadParticipant.threadId, [...threadIds]))
			.orderBy(asc(threadParticipant.createdAt), asc(threadParticipant.id));
		for (const row of rows) {
			const participants = byThread.get(row.threadId) ?? [];
			participants.push(toParticipant(row));
			byThread.set(row.threadId, participants);
		}
		return byThread;
	},
);

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
		'userId', recent.user_id, 'userName', recent.user_name, 'userImage', recent.user_image,
		'agentId', recent.agent_id, 'agentName', recent.agent_name, 'agentHandle', recent.agent_handle,
		'agentColor', recent.agent_color, 'agentFace', recent.agent_face
	) order by recent.last_active_at desc), '[]'::json)
	from (
		select ${user.id} as user_id, ${user.name} as user_name, ${user.image} as user_image,
			${agent.id} as agent_id, ${agent.name} as agent_name, ${agent.handle} as agent_handle,
			${agent.color} as agent_color, ${agent.face} as agent_face,
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
		group by 1, 2, 3, 4, 5, 6, 7, 8
	) as recent
)`;

/**
 * The agents a thread may mention or collaborate with, as a condition on
 * `agent`: its pod's crew, whether or not they have spoken yet.
 *
 * Wider than the participants on purpose. Somebody writing `@aquaman` — a
 * person composing — may name an agent who has not joined yet, and reading
 * that name against who has already spoken would leave every first mention
 * unrecognised.
 *
 * Every agent placed in a pod is crew: `agent_placement_check` keeps system
 * agents, a Scribe or a facilitator, out of pods, so they are never listed.
 */
export const crewOf = (podId: SQLWrapper | string) => eq(agent.podId, podId);
