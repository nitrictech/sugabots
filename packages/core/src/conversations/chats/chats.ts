export * as Chats from "./chats.ts";

import type { Chat, Message } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agent, chat, message, pod } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { crewOf, personAuthor, toMessage } from "../threads/participants.ts";
import { ThreadRepository } from "../threads/repository.ts";
import {
	decideFloor,
	type FloorDecision,
	type FloorMessage,
	loadFloorScope,
} from "../turns/floor.ts";
import { TurnRequests } from "../turns/requests.ts";

/**
 * Talking to a crew agent: a person opens a chat with an agent in a pod and
 * posts into it, and whoever has the floor after a message is asked to speak.
 */
export interface Interface {
	/**
	 * The person's chat with the pod's crew agent, opened on first use.
	 * Refused unless the person reaches the pod and the agent is its crew.
	 */
	readonly open: (input: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		userId: string;
	}) => Effect.Effect<Chat, ChatPlacementRejected>;
	/**
	 * Posts the person's message into the chat's main thread and gives the
	 * floor. Posting the same message again returns it unchanged. `undefined`
	 * when the person does not reach the chat.
	 */
	readonly post: (input: {
		chatId: string;
		/** Who is sending, as the caller already knows them. */
		author: { id: string; name: string; image: string | null };
		messageId: string;
		content: string;
	}) => Effect.Effect<Message | undefined, ChatMessageIdConflict | ChatAgentHasNoModel>;
	/**
	 * Decides who speaks after a committed message and asks for them (ADR
	 * 004), bringing any newly addressed crew agent into the thread. Runs in
	 * the caller's transaction, so it commits with the message.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<FloorDecision>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Chats");
	const threads = yield* ThreadRepository.Service;
	const requests = yield* TurnRequests.Service;

	const giveFloor = (committed: FloorMessage) =>
		transaction(
			Effect.gen(function* () {
				const scope = yield* query((db) => loadFloorScope(db, committed));
				const decision = decideFloor({
					...scope,
					content: committed.content,
					author: committed.author,
				});
				if (decision.kind === "facilitate") {
					yield* requests.queueFacilitation({
						threadId: committed.threadId,
						triggerMessageId: committed.id,
					});
				}
				if (decision.kind !== "turns") return decision;
				yield* threads.addAgents(
					committed.threadId,
					decision.agents.map(({ agentId }) => agentId),
				);
				for (const { agentId, reason } of decision.agents) {
					yield* requests.queueTurn({
						threadId: committed.threadId,
						agentId,
						triggerMessageId: committed.id,
						reason,
					});
				}
				return decision;
			}),
		);

	return Service.of({
		open: (input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						if (!(yield* placementAllowed(input))) return yield* new ChatPlacementRejected();
						return toChat(
							yield* threads.openChat({
								workspaceId: input.workspaceId,
								podId: input.podId,
								hostAgentId: input.hostAgentId,
								initiatorUserId: input.userId,
							}),
						);
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibleChat(input.chatId, input.author.id);
						if (!visible) return undefined;
						const author = personAuthor({
							userId: input.author.id,
							userName: input.author.name,
							userImage: input.author.image,
						});
						yield* query((db) =>
							db.execute(
								sql`select pg_advisory_xact_lock(hashtextextended(${`chat-message:${input.messageId}`}, 0))`,
							),
						);
						const [existing] = yield* query((db) =>
							db.select().from(message).where(eq(message.id, input.messageId)).limit(1),
						);
						if (existing) {
							if (
								existing.threadId !== visible.mainThreadId ||
								existing.authorUserId !== input.author.id ||
								existing.content !== input.content
							) {
								return yield* new ChatMessageIdConflict();
							}
							return toMessage(existing, author);
						}
						if ((yield* hostModelOf(visible.hostAgentId)) === null) {
							return yield* new ChatAgentHasNoModel();
						}
						const posted = yield* threads.post({
							id: input.messageId,
							threadId: visible.mainThreadId,
							author: input.author,
							content: input.content,
						});
						yield* giveFloor({
							id: posted.id,
							threadId: visible.mainThreadId,
							content: posted.content,
							author: { kind: "person" },
						});
						return toMessage(posted, author);
					}),
				),
			),

		giveFloor: (committed) => operation("giveFloor", giveFloor(committed)),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ThreadRepository.layer));

export class ChatPlacementRejected
	extends Data.TaggedError("ChatPlacementRejected")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The agent and pod are not available for this chat`;
	}
}

export class ChatMessageIdConflict
	extends Data.TaggedError("ChatMessageIdConflict")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That message ID is already used by a different message`;
	}
}

/**
 * The chat's agent has no model, so nothing could answer. Refused before the
 * message is saved rather than kept with a turn that will never run.
 */
export class ChatAgentHasNoModel
	extends Data.TaggedError("ChatAgentHasNoModel")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This agent has no model chosen, so it cannot answer yet`;
	}
}

/** Whether the person reaches the pod and the agent is crew in it. */
const placementAllowed = (input: {
	workspaceId: string;
	podId: string;
	hostAgentId: string;
	userId: string;
}) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: pod.id })
				.from(pod)
				.innerJoin(
					agent,
					and(
						eq(agent.id, input.hostAgentId),
						crewOf(pod.id),
						eq(agent.workspaceId, pod.workspaceId),
					),
				)
				.where(
					and(
						eq(pod.id, input.podId),
						eq(pod.workspaceId, input.workspaceId),
						reachesPod(pod.id, input.userId),
					),
				)
				.limit(1),
		),
		([allowed]) => allowed !== undefined,
	);

/** The chat, if the person reaches its pod. */
const visibleChat = (chatId: string, userId: string) =>
	isUuid(chatId)
		? Effect.map(
				query((db) =>
					db
						.select()
						.from(chat)
						.where(and(eq(chat.id, chatId), reachesPod(chat.podId, userId)))
						.limit(1),
				),
				([row]) => row,
			)
		: Effect.undefined;

const hostModelOf = (agentId: string) =>
	Effect.map(
		query((db) =>
			db.select({ model: agent.model }).from(agent).where(eq(agent.id, agentId)).limit(1),
		),
		([row]) => row?.model ?? null,
	);

function toChat(row: schema.ChatRow): Chat {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		hostAgentId: row.hostAgentId,
		mainThreadId: row.mainThreadId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
