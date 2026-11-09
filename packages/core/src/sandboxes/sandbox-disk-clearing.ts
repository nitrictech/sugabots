import type { RoutineExecutionState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DateTime, Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, routineExecution, thread, turn } from "../database/schema.ts";
import { Sandboxes } from "./sandboxes.ts";

/** Why a thread's folder may be cleared. */
export type ClearingReason = "thread_deleted" | "routine_run_ended" | "conversation_done";

export interface ClearableFolder {
	readonly threadId: string;
	readonly reason: ClearingReason;
}

/**
 * Frees the sandbox's disk by clearing the folders of threads nobody will
 * work in again, in {@link clearingOrder}, until its workspace's filesystem
 * is less than `belowShare` full. A cleared folder whose thread still exists
 * is left holding {@link CLEARED_NOTE_NAME}, for anyone who looks in it
 * again. Returns the folders it cleared.
 */
export function clearFinishedThreadFolders(
	sandbox: Sandboxes.Sandbox,
	workspaceId: string,
	belowShare: number,
): Effect.Effect<readonly ClearableFolder[], Sandboxes.Unavailable, Database> {
	return Effect.gen(function* () {
		const order = yield* clearingOrder(workspaceId, yield* threadFoldersIn(sandbox));
		if (order.length === 0) return [];
		const clearedOn = DateTime.formatIsoDateUtc(yield* DateTime.now);
		const clearing = yield* sandbox.exec(
			clearingScript(order, belowShare, clearedOn),
			CLEARING_OPTIONS,
		);
		// A clearing stopped at its timeout still reports the folders it got through.
		const cleared = new Set(threadIdsIn(clearing.stdout.text));
		return order.filter((folder) => cleared.has(folder.threadId));
	});
}

/**
 * Which of the threads with folders `threadIds` may have them cleared, in
 * the order they should be: threads that no longer exist, then routine runs
 * that have ended, then conversations marked done, each oldest last turn
 * first. A run's thread takes no turns once it ends, and marking a
 * conversation done is undone by anything new in it. A thread with a turn
 * still running, or waiting for a person, is never cleared.
 */
export function clearingOrder(
	workspaceId: string,
	threadIds: readonly string[],
): Effect.Effect<readonly ClearableFolder[], never, Database> {
	return Effect.gen(function* () {
		if (threadIds.length === 0) return [];
		const conversation = alias(thread, "conversation");
		const found = yield* query((db) =>
			db
				.select({
					id: thread.id,
					runState: routineExecution.state,
					conversationDoneAt: conversation.doneAt,
					activeTurns:
						sql<number>`count(*) filter (where ${inArray(turn.status, [...ACTIVE_TURN_STATUSES])})`.mapWith(
							Number,
						),
				})
				.from(thread)
				.leftJoin(conversation, eq(conversation.id, thread.conversationId))
				.leftJoin(routineExecution, eq(routineExecution.threadId, thread.id))
				.leftJoin(turn, eq(turn.threadId, thread.id))
				.where(and(eq(thread.workspaceId, workspaceId), inArray(thread.id, [...threadIds])))
				.groupBy(thread.id, conversation.doneAt, routineExecution.state)
				.orderBy(sql`max(${turn.startedAt}) nulls first`),
		);
		const existing = new Set(found.map((row) => row.id));
		const deleted = threadIds
			.filter((threadId) => !existing.has(threadId))
			.map((threadId): ClearableFolder => ({ threadId, reason: "thread_deleted" }));
		const finished = found
			.filter((row) => row.activeTurns === 0)
			.flatMap((row): ClearableFolder[] => {
				if (row.runState && ENDED_RUN_STATES.has(row.runState)) {
					return [{ threadId: row.id, reason: "routine_run_ended" }];
				}
				if (row.conversationDoneAt) return [{ threadId: row.id, reason: "conversation_done" }];
				return [];
			})
			// Stable, so each reason's folders stay oldest last turn first.
			.toSorted((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason]);
		return [...deleted, ...finished];
	});
}

/** The file a cleared folder is left holding, whose thread still exists. */
export const CLEARED_NOTE_NAME = "FOLDER-CLEARED.md";

const ENDED_RUN_STATES: ReadonlySet<RoutineExecutionState> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

const REASON_ORDER: Record<ClearingReason, number> = {
	thread_deleted: 0,
	routine_run_ended: 1,
	conversation_done: 2,
};

const LISTING_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 100_000 } as const;
/** Removing trees of many small files, such as dependencies, unlinks every one of them. */
const CLEARING_OPTIONS = { timeout: "2 minutes", maxOutputCharacters: 100_000 } as const;

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The threads with folders in the sandbox, less those already cleared to
 * nothing but {@link CLEARED_NOTE_NAME}. A name that isn't a thread's id is
 * no thread's, and is left alone.
 */
function threadFoldersIn(sandbox: Sandboxes.Sandbox) {
	return Effect.map(
		sandbox.exec(
			[
				"shopt -s nullglob",
				`for folder in ${Sandboxes.THREADS_DIRECTORY}/*/; do`,
				`  folder=\${folder%/}`,
				`  [ "$(ls -A -- "$folder")" = ${CLEARED_NOTE_NAME} ] || printf '%s\\n' "\${folder##*/}"`,
				"done",
			].join("\n"),
			LISTING_OPTIONS,
		),
		(listing) => threadIdsIn(listing.stdout.text),
	);
}

function threadIdsIn(output: string) {
	return output.split("\n").filter((line) => THREAD_ID.test(line));
}

/**
 * Clears `folders` in order, checking before each whether the workspace's
 * filesystem is still at least `belowShare` full, and prints the id of each
 * thread whose folder it cleared. If `df` fails, it clears nothing more.
 */
function clearingScript(
	folders: readonly ClearableFolder[],
	belowShare: number,
	clearedOn: string,
) {
	const note = `This folder was cleared on ${clearedOn} to free space on the sandbox's disk, which every agent in the pod shares, because its thread had finished. Clone or make again anything you need from it.`;
	return [
		`full() { df -B1 --output=used,avail ${Sandboxes.WORKSPACE_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		// $1: the thread's id. $2: "note" to leave the note in its place.
		"clear_folder() {",
		"  full || exit 0",
		`  local folder=${Sandboxes.THREADS_DIRECTORY}/$1`,
		`  rm -rf -- "$folder" || return 0`,
		`  if [ "$2" = note ]; then mkdir -p -- "$folder" && printf '%s\\n' ${Sandboxes.shellQuoted(note)} > "$folder/${CLEARED_NOTE_NAME}"; fi`,
		`  printf '%s\\n' "$1"`,
		"}",
		...folders.map(
			({ threadId, reason }) =>
				`clear_folder ${threadId}${reason === "thread_deleted" ? "" : " note"}`,
		),
	].join("\n");
}
