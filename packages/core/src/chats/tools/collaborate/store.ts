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
	chat,
	collaboration,
	message,
	turn,
} from "../../../database/schema.ts";
import { ChatEvents } from "../../chat-events.ts";
import { ChatEvent, type CollaborationChange } from "../../events.ts";
import { toCollaborationPart } from "../../store/collaboration-parts.ts";

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
	/** Records a collaboration whose chat `childChatId` is open, `waiting`. */
	readonly open: (input: {
		/** The chat it was asked from. */
		parentChatId: string;
		/** The chat people opened that the parent is in, or the parent itself. */
		rootChatId: string;
		parentMessageId: string;
		turnId: string;
		/** The collaboration's own chat, opened in the same transaction. */
		chatId: string;
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
	 * Records `answer` as the reply to the collaboration whose chat is
	 * `childChatId`, if one is outstanding.
	 */
	readonly answer: (childChatId: string, answer: string) => Effect.Effect<void>;
	/**
	 * Fails the collaborations asked for in these chats that are still
	 * waiting or pending, because the automation run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (chatIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Fails the collaboration asked of `collaboratorBotId` in its chat
	 * `childChatId`, if it is still waiting or pending, because the
	 * collaborator's turn there ended without answering. One the collaborator
	 * still has an active turn for is left alone: that turn may answer it.
	 */
	readonly failUnanswered: (collaborator: {
		childChatId: string;
		collaboratorBotId: string;
	}) => Effect.Effect<void>;
}

/** The collaboration table's writes, which `Collaborations` builds for itself. */
export const makeRecords = Effect.gen(function* () {
	const operation = yield* serviceOperations<Records>("Collaborations");
	const { emit } = yield* ChatEvents.Service;

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
									chatId: input.chatId,
									parentChatId: input.parentChatId,
									rootChatId: input.rootChatId,
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
								.select({ workspaceId: chat.workspaceId })
								.from(chat)
								.where(eq(chat.id, input.parentChatId))
								.limit(1),
						);
						if (!address) {
							return yield* Effect.die(new Error("A collaboration's parent chat is gone"));
						}
						yield* emit([
							ChatEvent.CollaborationOpened({
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
							ChatEvent.CollaborationStoppedWaiting(
								collaborationChange(updated, current.collaboratorName),
							),
						]);
						return { _tag: "MovedOn" };
					}),
				),
			),

		answer: (childChatId, answer) =>
			operation(
				"answer",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(eq(collaboration.chatId, childChatId));
						if (!current || current.row.status === "answered" || current.row.status === "failed") {
							return;
						}
						const updated = yield* writeStatus(current.row.id, { status: "answered", answer });
						yield* emit([
							ChatEvent.CollaborationAnswered({
								...collaborationChange(updated, current.collaboratorName),
								askerToResume: askerToResume(current),
							}),
						]);
					}),
				),
			),

		failUnder: (chatIds) =>
			operation(
				"failUnder",
				transaction(
					Effect.gen(function* () {
						if (chatIds.length === 0) return;
						const unanswered = yield* query((db) =>
							db
								.select({ collaboration, collaboratorName: bot.name })
								.from(collaboration)
								.innerJoin(bot, eq(bot.id, collaboration.collaboratorBotId))
								.where(
									and(
										inArray(collaboration.parentChatId, [...chatIds]),
										inArray(collaboration.status, ["waiting", "pending"]),
									),
								)
								.orderBy(collaboration.createdAt, collaboration.id)
								.for("update", { of: collaboration, skipLocked: true }),
						);
						const failed = yield* Effect.forEach(unanswered, (row) =>
							Effect.map(writeStatus(row.collaboration.id, { status: "failed" }), (updated) =>
								ChatEvent.CollaborationFailed({
									...collaborationChange(updated, row.collaboratorName),
									askerToResume: null,
								}),
							),
						);
						yield* emit(failed);
					}),
				),
			),

		failUnanswered: ({ childChatId, collaboratorBotId }) =>
			operation(
				"failUnanswered",
				transaction(
					Effect.gen(function* () {
						const current = yield* locked(
							and(
								eq(collaboration.chatId, childChatId),
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
										eq(turn.chatId, childChatId),
										eq(turn.botId, collaboratorBotId),
										inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
									),
								)
								.limit(1),
						);
						if (stillAnswering) return;
						const updated = yield* writeStatus(current.row.id, { status: "failed" });
						yield* emit([
							ChatEvent.CollaborationFailed({
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
		parentChatId: row.parentChatId,
		parentMessageId: row.parentMessageId,
		collaboration: toCollaborationPart(row, collaboratorName),
	};
}
