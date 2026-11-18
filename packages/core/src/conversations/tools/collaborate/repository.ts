import { and, eq, inArray, type SQL } from "drizzle-orm";
import { Effect } from "effect";
import {
	type Database,
	query,
	serviceOperations,
	type Transaction,
	transaction,
	writtenRow,
} from "../../../database/database.ts";
import type * as schema from "../../../database/schema.ts";
import {
	ACTIVE_TURN_STATUSES,
	bot,
	collaboration,
	conversation,
	message,
	turn,
} from "../../../database/schema.ts";
import { ConversationEvents } from "../../conversation-events.ts";
import { type CollaborationChange, ConversationEvent } from "../../events.ts";
import { toCollaborationPart } from "../../repository/collaboration-parts.ts";

/**
 * The only writer of `collaboration`: one bot asking another for help.
 *
 * A collaboration moves through `waiting` (the asking turn is blocked on it),
 * `pending` (it gave up waiting; the answer will resume it), and `answered` or
 * `failed`. Two writers can race for a collaboration, the waiting tool and the
 * collaborator's completing turn, so every transition locks the row and acts
 * on its current status, and announces what changed.
 */
export interface Records {
	/** Records a collaboration whose conversation `childConversationId` is open, `waiting`. */
	readonly open: (input: {
		/** The conversation it was asked from. */
		parentConversationId: string;
		/** The conversation people opened that the parent is in, or the parent itself. */
		rootConversationId: string;
		parentMessageId: string;
		turnId: string;
		/** The collaboration's own conversation, opened in the same transaction. */
		conversationId: string;
		briefMessageId: string;
		collaborator: { id: string; name: string };
		brief: string;
		/** How far into the asking reply's text the collaboration was made. */
		atOffset: number;
	}) => Effect.Effect<schema.CollaborationRow>;
	/**
	 * Marks that the asking turn stopped waiting, so the answer resumes it
	 * later, unless the collaboration has already ended; returns which. A
	 * collaboration that is gone reads as failed.
	 */
	readonly stopWaiting: (collaborationId: string) => Effect.Effect<WaitOutcome>;
	/**
	 * Records `answer` as the reply to the collaboration whose conversation is
	 * `childConversationId`, if one is outstanding.
	 */
	readonly answer: (childConversationId: string, answer: string) => Effect.Effect<void>;
	/**
	 * Fails the collaborations asked for in these conversations that are still
	 * waiting or pending, because the automation run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (conversationIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Fails the collaboration asked of `collaboratorBotId` in its conversation
	 * `childConversationId`, if it is still waiting or pending, because the
	 * collaborator's turn there ended without answering. One the collaborator
	 * still has an active turn for is left alone: that turn may answer it.
	 */
	readonly failUnanswered: (collaborator: {
		childConversationId: string;
		collaboratorBotId: string;
	}) => Effect.Effect<void>;
}

/** The collaboration table's writes, which `Collaborations` builds for itself. */
export const makeRecords = Effect.gen(function* () {
	const operation = yield* serviceOperations<Records>("Collaborations");
	const { emit } = yield* ConversationEvents.Service;

	return {
		open: (input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const opened = yield* query((db) =>
							db
								.insert(collaboration)
								.values({
									conversationId: input.conversationId,
									parentConversationId: input.parentConversationId,
									rootConversationId: input.rootConversationId,
									parentMessageId: input.parentMessageId,
									turnId: input.turnId,
									collaboratorBotId: input.collaborator.id,
									brief: input.brief,
									atOffset: input.atOffset,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("collaboration")));
						const [address] = yield* query((db) =>
							db
								.select({ workspaceId: conversation.workspaceId })
								.from(conversation)
								.where(eq(conversation.id, input.parentConversationId))
								.limit(1),
						);
						if (!address) {
							return yield* Effect.die(new Error("A collaboration's parent conversation is gone"));
						}
						yield* emit([
							ConversationEvent.CollaborationOpened({
								...collaborationChange(opened, input.collaborator.name),
								workspaceId: address.workspaceId,
								collaboratorBotId: input.collaborator.id,
								briefMessageId: input.briefMessageId,
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
					Effect.gen(function* (): Effect.fn.Return<WaitOutcome, never, Database | Transaction> {
						const current = yield* locked(eq(collaboration.id, collaborationId));
						if (!current) return { _tag: "Failed" };
						const status = current.row.status;
						if (status === "answered")
							return { _tag: "Answered", answer: current.row.answer ?? "" };
						if (status === "failed") return { _tag: "Failed" };
						if (status === "pending") return { _tag: "MovedOn" };
						const updated = yield* writeStatus(current.row.id, { status: "pending" });
						yield* emit([
							ConversationEvent.CollaborationStoppedWaiting(
								collaborationChange(updated, current.collaboratorName),
							),
						]);
						return { _tag: "MovedOn" };
					}),
				),
			),

		answer: (childConversationId, answer) =>
			operation(
				"answer",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(eq(collaboration.conversationId, childConversationId));
						if (!current || current.row.status === "answered" || current.row.status === "failed") {
							return;
						}
						const updated = yield* writeStatus(current.row.id, { status: "answered", answer });
						yield* emit([
							ConversationEvent.CollaborationAnswered({
								...collaborationChange(updated, current.collaboratorName),
								askerToResume: askerToResume(current),
							}),
						]);
					}),
				),
			),

		failUnder: (conversationIds) =>
			operation(
				"failUnder",
				transaction(
					Effect.gen(function* () {
						if (conversationIds.length === 0) return;
						const unanswered = yield* query((db) =>
							db
								.select({ collaboration, collaboratorName: bot.name })
								.from(collaboration)
								.innerJoin(bot, eq(bot.id, collaboration.collaboratorBotId))
								.where(
									and(
										inArray(collaboration.parentConversationId, [...conversationIds]),
										inArray(collaboration.status, ["waiting", "pending"]),
									),
								)
								.orderBy(collaboration.createdAt, collaboration.id)
								.for("update", { of: collaboration, skipLocked: true }),
						);
						const failed = yield* Effect.forEach(unanswered, (row) =>
							Effect.map(writeStatus(row.collaboration.id, { status: "failed" }), (updated) =>
								ConversationEvent.CollaborationFailed({
									...collaborationChange(updated, row.collaboratorName),
									askerToResume: null,
								}),
							),
						);
						yield* emit(failed);
					}),
				),
			),

		failUnanswered: ({ childConversationId, collaboratorBotId }) =>
			operation(
				"failUnanswered",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(
							and(
								eq(collaboration.conversationId, childConversationId),
								eq(collaboration.collaboratorBotId, collaboratorBotId),
								inArray(collaboration.status, ["waiting", "pending"]),
							),
						);
						if (!current) return;
						const [stillAnswering] = yield* query((db) =>
							db
								.select({ id: turn.id })
								.from(turn)
								.where(
									and(
										eq(turn.conversationId, childConversationId),
										eq(turn.botId, collaboratorBotId),
										inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
									),
								)
								.limit(1),
						);
						if (stillAnswering) return;
						const updated = yield* writeStatus(current.row.id, { status: "failed" });
						yield* emit([
							ConversationEvent.CollaborationFailed({
								...collaborationChange(updated, current.collaboratorName),
								askerToResume: askerToResume(current),
							}),
						]);
					}),
				),
			),
	} satisfies Records;
});

/**
 * How the asking turn's wait for a collaboration ended: with the
 * collaborator's answer, by moving on so the answer resumes it later, or with
 * the collaboration failed, so no answer is coming.
 */
export type WaitOutcome =
	| { readonly _tag: "Answered"; readonly answer: string }
	| { readonly _tag: "MovedOn" }
	| { readonly _tag: "Failed" };

/**
 * The collaboration, locked for update so a transition is serialised, with
 * the names its announcement and the asker's resume need.
 */
const locked = (by: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({
					collaboration,
					collaboratorName: bot.name,
					askingBotId: message.authorBotId,
				})
				.from(collaboration)
				.innerJoin(bot, eq(bot.id, collaboration.collaboratorBotId))
				.innerJoin(message, eq(message.id, collaboration.parentMessageId))
				.where(by)
				.limit(1)
				.for("update", { of: collaboration }),
		),
		([row]) =>
			row?.askingBotId
				? {
						row: row.collaboration,
						collaboratorName: row.collaboratorName,
						askingBotId: row.askingBotId,
					}
				: undefined,
	);

/** The asking bot, if it stopped waiting for the collaboration about to end. */
function askerToResume(current: {
	row: schema.CollaborationRow;
	askingBotId: string;
}): string | null {
	return current.row.status === "pending" ? current.askingBotId : null;
}

const writeStatus = (
	collaborationId: string,
	change: Pick<schema.CollaborationRow, "status"> &
		Partial<Pick<schema.CollaborationRow, "answer">>,
) =>
	query((db) =>
		db.update(collaboration).set(change).where(eq(collaboration.id, collaborationId)).returning(),
	).pipe(Effect.flatMap(writtenRow("collaboration")));

/** The collaboration as an event carries it once it has changed. */
function collaborationChange(
	row: schema.CollaborationRow,
	collaboratorName: string,
): CollaborationChange {
	return {
		parentConversationId: row.parentConversationId,
		parentMessageId: row.parentMessageId,
		collaboration: toCollaborationPart(row, collaboratorName),
	};
}
