import type { RoutineExecutionState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, agent, routineExecution, thread, turn } from "../database/schema.ts";
import { Sandboxes } from "./sandboxes.ts";

/** The caches in each agent's home, relative to it, that clearing may remove. */
export const AGENT_CACHES = [".cache", ".npm", ".bun/install/cache"] as const;

type AgentCache = (typeof AGENT_CACHES)[number];

/** Something in a sandbox's workspace that may be cleared, and why. */
export type Clearable =
	| {
			readonly reason: "thread_deleted" | "routine_run_ended" | "conversation_done";
			readonly threadId: string;
	  }
	| { readonly reason: "agent_deleted"; readonly agentId: string }
	| { readonly reason: "agent_cache"; readonly agentId: string; readonly cache: AgentCache };

export type ClearingReason = Clearable["reason"];

export interface Clearing {
	readonly cleared: readonly Clearable[];
	/**
	 * Whether it was stopped at its timeout, which loses everything it
	 * printed: it may have cleared folders `cleared` doesn't list.
	 */
	readonly stoppedAtTimeout: boolean;
}

/** The threads' folders and agents' homes in a sandbox's workspace, by id. */
export interface WorkspaceFolders {
	readonly threadIds: readonly string[];
	readonly agentIds: readonly string[];
}

/**
 * The most folders one clearing takes on. Its script is a single argument
 * to bash, which Linux caps at 128 KiB, and each folder adds at most 85
 * bytes to it. Folders past these are cleared the next time.
 */
export const MAX_FOLDERS_CLEARED_AT_ONCE = 1_000;

/**
 * Frees the sandbox's disk by removing, in {@link clearingOrder}, the
 * folders nobody will work in again and the caches in agents' homes, until
 * its workspace's filesystem is less than `belowShare` full.
 *
 * Only while no lease is held on the sandbox: a command running meanwhile
 * could lose the folder or cache it is using.
 */
export function freeDiskSpace(
	sandbox: Sandboxes.Sandbox,
	workspaceId: string,
	belowShare: number,
): Effect.Effect<Clearing, Sandboxes.Unavailable, Database> {
	return Effect.gen(function* () {
		const clearable = yield* clearingOrder(workspaceId, yield* workspaceFoldersIn(sandbox));
		const order = clearable.slice(0, MAX_FOLDERS_CLEARED_AT_ONCE);
		const clearing = yield* sandbox.exec(clearingScript(order, belowShare), CLEARING_OPTIONS);
		const cleared = new Set(clearing.stdout.text.split("\n"));
		return {
			cleared: order.filter((folder) => cleared.has(pathOf(folder))),
			stoppedAtTimeout: clearing.exitCode === null,
		};
	});
}

/**
 * What in `folders` may be cleared, in the order it should be: the folders
 * of threads that no longer exist, then the homes of agents that no longer
 * exist, then the folders of routine runs that have ended, then the caches
 * in the remaining agents' homes, then the folders of conversations marked
 * done. Threads go oldest last turn first. A run's thread takes no turns
 * once it ends, and marking a conversation done is undone by anything new
 * in it, so its folder may still hold work and goes last. A thread with a
 * turn still running, or waiting for a person, is never cleared.
 */
export function clearingOrder(
	workspaceId: string,
	folders: WorkspaceFolders,
): Effect.Effect<readonly Clearable[], never, Database> {
	return Effect.gen(function* () {
		const threads = yield* clearableThreads(workspaceId, folders.threadIds);
		const agents = yield* clearableAgentFolders(workspaceId, folders.agentIds);
		// Stable, so each reason's folders keep their order.
		return [...threads, ...agents].toSorted(
			(a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason],
		);
	});
}

const REASON_ORDER: Record<ClearingReason, number> = {
	thread_deleted: 0,
	agent_deleted: 1,
	routine_run_ended: 2,
	agent_cache: 3,
	conversation_done: 4,
};

/** Which of the threads `threadIds` may have their folders cleared, oldest last turn first. */
function clearableThreads(workspaceId: string, threadIds: readonly string[]) {
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
			.map((threadId): Clearable => ({ threadId, reason: "thread_deleted" }));
		const finished = found
			.filter((row) => row.activeTurns === 0)
			.flatMap((row): Clearable[] => {
				if (row.runState && ENDED_RUN_STATES.has(row.runState)) {
					return [{ threadId: row.id, reason: "routine_run_ended" }];
				}
				if (row.conversationDoneAt) return [{ threadId: row.id, reason: "conversation_done" }];
				return [];
			});
		return [...deleted, ...finished];
	});
}

const ENDED_RUN_STATES: ReadonlySet<RoutineExecutionState> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

/**
 * The homes in `agentIds` of agents that no longer exist, and the caches
 * in the rest. Agents never move between pods, so one that still exists
 * may still work in this sandbox.
 */
function clearableAgentFolders(workspaceId: string, agentIds: readonly string[]) {
	return Effect.gen(function* () {
		if (agentIds.length === 0) return [];
		const found = yield* query((db) =>
			db
				.select({ id: agent.id })
				.from(agent)
				.where(and(eq(agent.workspaceId, workspaceId), inArray(agent.id, [...agentIds]))),
		);
		const existing = new Set(found.map((row) => row.id));
		return agentIds.flatMap((agentId): Clearable[] =>
			existing.has(agentId)
				? AGENT_CACHES.map((cache) => ({ agentId, cache, reason: "agent_cache" }))
				: [{ agentId, reason: "agent_deleted" }],
		);
	});
}

function pathOf(clearable: Clearable) {
	switch (clearable.reason) {
		case "thread_deleted":
		case "routine_run_ended":
		case "conversation_done":
			return `${Sandboxes.THREADS_DIRECTORY}/${clearable.threadId}`;
		case "agent_deleted":
			return `${Sandboxes.AGENTS_DIRECTORY}/${clearable.agentId}`;
		case "agent_cache":
			return `${Sandboxes.AGENTS_DIRECTORY}/${clearable.agentId}/${clearable.cache}`;
	}
}

const LISTING_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 200_000 } as const;
/** Removing trees of many small files, such as dependencies, unlinks every one of them. */
const CLEARING_OPTIONS = { timeout: "2 minutes", maxOutputCharacters: 100_000 } as const;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_FOLDER = new RegExp(`^${Sandboxes.THREADS_DIRECTORY}/(${ID})$`);
const AGENT_HOME = new RegExp(`^${Sandboxes.AGENTS_DIRECTORY}/(${ID})$`);

/**
 * The threads' folders and agents' homes in the sandbox. A name that isn't
 * an id is no thread's or agent's, and is left alone.
 */
function workspaceFoldersIn(sandbox: Sandboxes.Sandbox) {
	return Effect.map(
		sandbox.exec(
			`find ${Sandboxes.THREADS_DIRECTORY} ${Sandboxes.AGENTS_DIRECTORY} -mindepth 1 -maxdepth 1 -type d 2>/dev/null; exit 0`,
			LISTING_OPTIONS,
		),
		(listing): WorkspaceFolders => {
			const paths = listing.stdout.text.split("\n");
			return {
				threadIds: paths.flatMap((path) => THREAD_FOLDER.exec(path)?.[1] ?? []),
				agentIds: paths.flatMap((path) => AGENT_HOME.exec(path)?.[1] ?? []),
			};
		},
	);
}

/**
 * Where a clearing moves each path before removing it. A removal cut short,
 * such as at the clearing's timeout, then leaves nothing half-removed where
 * an agent would trust it, like a cache missing some of a package's files.
 * The next clearing removes whatever is left here.
 */
export const SET_ASIDE_DIRECTORY = `${Sandboxes.WORKSPACE_DIRECTORY}/.sugabots-clearing`;

/**
 * Removes what an earlier clearing set aside, then the paths of
 * `clearables` in order, checking before each whether the workspace's
 * filesystem is still at least `belowShare` full, and prints each path it
 * removed. A path that isn't there is skipped. If `df` fails, it removes
 * nothing more. A path that can't be set aside, such as when the disk is
 * too full for {@link SET_ASIDE_DIRECTORY}, is removed where it is.
 */
function clearingScript(clearables: readonly Clearable[], belowShare: number) {
	return [
		`set_aside=${SET_ASIDE_DIRECTORY}`,
		`rm -rf -- "$set_aside"`,
		`mkdir -p -- "$set_aside" || set_aside=`,
		`full() { df -B1 --output=used,avail ${Sandboxes.WORKSPACE_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		"n=0",
		[
			`remove() { [ -e "$1" ] || return 0; full || exit 0; n=$((n + 1));`,
			`if [ -n "$set_aside" ] && mv -T -- "$1" "$set_aside/$n"; then rm -rf -- "$set_aside/$n"; else rm -rf -- "$1"; fi`,
			`&& printf '%s\\n' "$1"; }`,
		].join(" "),
		...clearables.map((clearable) => `remove ${pathOf(clearable)}`),
	].join("\n");
}
