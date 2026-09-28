export * as CollaborationRepository from "./repository.ts";

import { and, eq, inArray, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import type * as schema from "../../../database/schema.ts";
import { agent, collaboration, message } from "../../../database/schema.ts";
import { ConversationEvents } from "../../conversation-events.ts";
import { ConversationEvent } from "../../events.ts";
import { collaborationChange } from "../../threads/collaborations.ts";

/**
 * The only writer of `collaboration`: one crew agent asking another for help.
 *
 * A collaboration moves through `waiting` (the asking turn is blocked on it),
 * `pending` (it gave up waiting; the answer will resume it), and `answered` or
 * `failed`. Two writers can race for a collaboration, the waiting tool and the
 * collaborator's completing turn, so every transition locks the row and acts
 * on its current status, and announces what changed.
 */
export interface Interface {
	/** Records a collaboration whose thread `childThreadId` is open, `waiting`. */
	readonly open: (input: {
		parentThreadId: string;
		parentMessageId: string;
		turnId: string;
		childThreadId: string;
		collaborator: { id: string; name: string };
		brief: string;
		/** How far into the asking reply's text the collaboration was made. */
		atOffset: number;
		/** For the announcement: the parent thread's workspace. */
		workspaceId: string;
		/** For the announcement: the collaborator's chat in the pod, whose history now lists the thread. */
		recipientChatId: string | null;
	}) => Effect.Effect<schema.CollaborationRow>;
	/**
	 * Marks that the asking turn stopped waiting. `false` when the
	 * collaboration is no longer waiting, such as when it was answered.
	 */
	readonly stopWaiting: (collaborationId: string) => Effect.Effect<boolean>;
	/** The collaborator's reply, once recorded. */
	readonly answerOf: (collaborationId: string) => Effect.Effect<string | undefined>;
	/**
	 * Records `answer` as the reply to the collaboration whose thread is
	 * `childThreadId`. `undefined` when there is none outstanding.
	 */
	readonly answer: (childThreadId: string, answer: string) => Effect.Effect<Answered | undefined>;
	/**
	 * Fails the collaborations asked for in these threads that are still
	 * waiting or pending, because the routine run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (threadIds: readonly string[]) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/CollaborationRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("CollaborationRepository");
	const { emit } = yield* ConversationEvents.Service;

	return Service.of({
		open: (input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const [opened] = yield* query((db) =>
							db
								.insert(collaboration)
								.values({
									parentThreadId: input.parentThreadId,
									parentMessageId: input.parentMessageId,
									turnId: input.turnId,
									childThreadId: input.childThreadId,
									collaboratorAgentId: input.collaborator.id,
									brief: input.brief,
									atOffset: input.atOffset,
								})
								.returning(),
						);
						if (!opened) {
							return yield* Effect.die(new Error("Collaboration insert returned no row"));
						}
						yield* emit([
							ConversationEvent.CollaborationOpened({
								...collaborationChange(opened, input.collaborator.name),
								workspaceId: input.workspaceId,
								recipientChatId: input.recipientChatId,
							}),
						]);
						return opened;
					}),
				),
			),

		stopWaiting: (collaborationId) =>
			operation(
				"stopWaiting",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(eq(collaboration.id, collaborationId));
						if (current?.row.status !== "waiting") return false;
						const updated = yield* writeStatus(current.row.id, { status: "pending" });
						yield* emit([
							ConversationEvent.CollaborationStoppedWaiting(
								collaborationChange(updated, current.collaboratorName),
							),
						]);
						return true;
					}),
				),
			),

		answerOf: (collaborationId) =>
			operation(
				"answerOf",
				Effect.map(
					query((db) =>
						db
							.select({ answer: collaboration.answer })
							.from(collaboration)
							.where(eq(collaboration.id, collaborationId))
							.limit(1),
					),
					([row]) => row?.answer ?? undefined,
				),
			),

		answer: (childThreadId, answer) =>
			operation(
				"answer",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(eq(collaboration.childThreadId, childThreadId));
						if (!current || current.row.status === "answered" || current.row.status === "failed") {
							return undefined;
						}
						const updated = yield* writeStatus(current.row.id, { status: "answered", answer });
						yield* emit([
							ConversationEvent.CollaborationAnswered(
								collaborationChange(updated, current.collaboratorName),
							),
						]);
						return {
							collaboration: updated,
							askingAgentId: current.askingAgentId,
							askerMovedOn: current.row.status === "pending",
						};
					}),
				),
			),

		failUnder: (threadIds) =>
			operation(
				"failUnder",
				transaction(
					Effect.gen(function* () {
						if (threadIds.length === 0) return;
						const unanswered = yield* query((db) =>
							db
								.select({ collaboration, collaboratorName: agent.name })
								.from(collaboration)
								.innerJoin(agent, eq(agent.id, collaboration.collaboratorAgentId))
								.where(
									and(
										inArray(collaboration.parentThreadId, [...threadIds]),
										inArray(collaboration.status, ["waiting", "pending"]),
									),
								)
								.orderBy(collaboration.createdAt, collaboration.id)
								.for("update", { of: collaboration, skipLocked: true }),
						);
						const failed = yield* Effect.forEach(unanswered, (row) =>
							Effect.map(writeStatus(row.collaboration.id, { status: "failed" }), (updated) =>
								ConversationEvent.CollaborationFailed(
									collaborationChange(updated, row.collaboratorName),
								),
							),
						);
						yield* emit(failed);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** A collaboration answered, and who asked for it. */
export interface Answered {
	readonly collaboration: schema.CollaborationRow;
	readonly askingAgentId: string;
	/** The asking turn had stopped waiting, so nothing is reading the answer yet. */
	readonly askerMovedOn: boolean;
}

/**
 * The collaboration, locked for update so a transition is serialised, with
 * the names its announcement and the asker's resume need.
 */
const locked = (by: SQL) =>
	Effect.map(
		query((db) =>
			db
				.select({
					collaboration,
					collaboratorName: agent.name,
					askingAgentId: message.authorAgentId,
				})
				.from(collaboration)
				.innerJoin(agent, eq(agent.id, collaboration.collaboratorAgentId))
				.innerJoin(message, eq(message.id, collaboration.parentMessageId))
				.where(by)
				.limit(1)
				.for("update", { of: collaboration }),
		),
		([row]) =>
			row?.askingAgentId
				? {
						row: row.collaboration,
						collaboratorName: row.collaboratorName,
						askingAgentId: row.askingAgentId,
					}
				: undefined,
	);

const writeStatus = (
	collaborationId: string,
	change: Pick<schema.CollaborationRow, "status"> &
		Partial<Pick<schema.CollaborationRow, "answer">>,
) =>
	Effect.flatMap(
		query((db) =>
			db.update(collaboration).set(change).where(eq(collaboration.id, collaborationId)).returning(),
		),
		([updated]) =>
			updated
				? Effect.succeed(updated)
				: Effect.die(new Error("Collaboration disappeared during update")),
	);
