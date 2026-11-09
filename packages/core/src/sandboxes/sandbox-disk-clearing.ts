import type { RoutineExecutionState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, routineExecution, thread, turn } from "../database/schema.ts";
import { Sandboxes } from "./sandboxes.ts";

/** Why a thread's folder may be cleared. */
export type ClearingReason = "thread_deleted" | "routine_run_ended" | "conversation_done";

export interface ClearableFolder {
	readonly threadId: string;
	readonly reason: ClearingReason;
}

export interface Clearing {
	readonly cleared: readonly ClearableFolder[];
	/**
	 * Whether it was stopped at its timeout, which loses everything it
	 * printed: it may have cleared folders `cleared` doesn't list.
	 */
	readonly stoppedAtTimeout: boolean;
}

/**
 * The most folders one clearing takes on. Its script is a single argument
 * to bash, which Linux caps at 128 KiB, and each folder adds 50 bytes to
 * it. Folders past these are cleared the next time.
 */
export const MAX_FOLDERS_CLEARED_AT_ONCE = 1_000;

/**
 * Frees the sandbox's disk by removing the folders of threads nobody will
 * work in again, in {@link clearingOrder}, until its workspace's filesystem
 * is less than `belowShare` full.
 */
export function clearFinishedThreadFolders(
	sandbox: Sandboxes.Sandbox,
	workspaceId: string,
	belowShare: number,
): Effect.Effect<Clearing, Sandboxes.Unavailable, Database> {
	return Effect.gen(function* () {
		const clearable = yield* clearingOrder(workspaceId, yield* threadFoldersIn(sandbox));
		if (clearable.length === 0) return { cleared: [], stoppedAtTimeout: false };
		const order = clearable.slice(0, MAX_FOLDERS_CLEARED_AT_ONCE);
		const clearing = yield* sandbox.exec(clearingScript(order, belowShare), CLEARING_OPTIONS);
		const cleared = new Set(threadIdsIn(clearing.stdout.text));
		return {
			cleared: order.filter((folder) => cleared.has(folder.threadId)),
			stoppedAtTimeout: clearing.exitCode === null,
		};
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
 * The threads with folders in the sandbox. A name that isn't a thread's id
 * is no thread's, and is left alone.
 */
function threadFoldersIn(sandbox: Sandboxes.Sandbox) {
	return Effect.map(
		sandbox.exec(
			`find ${Sandboxes.THREADS_DIRECTORY} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null; exit 0`,
			LISTING_OPTIONS,
		),
		(listing) => threadIdsIn(listing.stdout.text),
	);
}

function threadIdsIn(output: string) {
	return output.split("\n").filter((line) => THREAD_ID.test(line));
}

/**
 * Removes `folders` in order, checking before each whether the workspace's
 * filesystem is still at least `belowShare` full, and prints the id of each
 * thread whose folder it removed. If `df` fails, it removes nothing more.
 */
function clearingScript(folders: readonly ClearableFolder[], belowShare: number) {
	return [
		`full() { df -B1 --output=used,avail ${Sandboxes.WORKSPACE_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		// $1: the thread's id.
		`clear_folder() { full || exit 0; rm -rf -- "${Sandboxes.THREADS_DIRECTORY}/$1" && printf '%s\\n' "$1"; }`,
		...folders.map(({ threadId }) => `clear_folder ${threadId}`),
	].join("\n");
}
