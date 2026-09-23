import type { Message, MessagePart, ThreadParticipant } from "@sugabots/contracts";
import { handleFromName, messageStatusSchema } from "@sugabots/contracts";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { Executor } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agent, threadParticipant, user } from "../../database/schema.ts";
import type { PlacedPartsOf } from "./placed-parts.ts";

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
	agentHue: agent.hue,
	agentFace: agent.face,
};

export interface ParticipantRow {
	userId: string | null;
	userName: string | null;
	userEmail: string | null;
	userImage: string | null;
	agentId: string | null;
	agentName: string | null;
	agentHandle: string | null;
	agentHue: number | null;
	agentFace: schema.AgentRow["face"] | null;
}

export function toParticipant(row: ParticipantRow): ThreadParticipant {
	if (row.userId && row.userName && row.userEmail) {
		return {
			kind: "person",
			id: row.userId,
			name: row.userName,
			email: row.userEmail,
			handle: handleFromName(row.userName),
			image: row.userImage,
		};
	}
	if (row.agentId && row.agentName && row.agentHandle && row.agentHue !== null && row.agentFace) {
		return {
			kind: "agent",
			id: row.agentId,
			name: row.agentName,
			handle: row.agentHandle,
			hue: row.agentHue,
			face: row.agentFace,
		};
	}
	throw new Error("Thread participant has no identity");
}

/** A person as a message author, for rows where the author is known to be a user. */
export function personAuthor(person: {
	userId: string;
	userName: string;
	userEmail: string;
	userImage: string | null;
}): ParticipantRow {
	return {
		...person,
		agentId: null,
		agentName: null,
		agentHandle: null,
		agentHue: null,
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
	/** Why the turn behind a failed reply failed, in the provider's words. */
	error?: string | null,
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

/** Everyone in a thread, in the order they joined. */
export const loadParticipants = Effect.fn("Participants.loadParticipants")(function* (
	db: Executor,
	threadId: string,
) {
	const rows = yield* db
		.select(participantColumns)
		.from(threadParticipant)
		.leftJoin(user, eq(user.id, threadParticipant.userId))
		.leftJoin(agent, eq(agent.id, threadParticipant.agentId))
		.where(eq(threadParticipant.threadId, threadId))
		.orderBy(asc(threadParticipant.createdAt), asc(threadParticipant.id));
	return rows.map(toParticipant);
});

/**
 * The agents a thread may mention or collaborate with: its pod's crew, whether
 * or not they have spoken yet.
 *
 * Wider than the participants on purpose. Somebody writing `@aquaman` — a
 * person composing — may name an agent who has not joined yet, and reading
 * that name against who has already spoken would leave every first mention
 * unrecognised.
 *
 * System agents are left out: a Scribe or a facilitator is not somebody you talk to.
 */
export const loadCrew = Effect.fn("Participants.loadCrew")(function* (
	db: Executor,
	pod: { id: string; workspaceId: string },
) {
	const rows = yield* db
		.select({
			id: agent.id,
			name: agent.name,
			handle: agent.handle,
			hue: agent.hue,
			face: agent.face,
		})
		.from(agent)
		.where(
			and(
				eq(agent.podId, pod.id),
				eq(agent.workspaceId, pod.workspaceId),
				isNull(agent.systemAgentKey),
			),
		)
		.orderBy(asc(agent.name));
	return rows.map((row): ThreadParticipant => ({ kind: "agent", ...row }));
});
