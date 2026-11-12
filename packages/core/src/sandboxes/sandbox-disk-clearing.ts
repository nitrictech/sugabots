import type { RoutineExecutionState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, agent, routineExecution, thread, turn } from "../database/schema.ts";
import { Sandboxes } from "./sandboxes.ts";

/** Caches in each agent's home that clearing may remove. */
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

type ClearingReason = Clearable["reason"];

export interface Clearing {
	readonly cleared: readonly Clearable[];
	/** Whether it hit its timeout, losing its output, so `cleared` may be missing some. */
	readonly stoppedAtTimeout: boolean;
}

/** Ids of the thread folders and agent homes in a sandbox. */
export interface WorkspaceFolders {
	readonly threadIds: readonly string[];
	readonly agentIds: readonly string[];
}

/**
 * Linux caps the script, a single bash argument, at 128 KiB, and each
 * folder adds up to 85 bytes. The rest wait for the next clearing.
 */
export const MAX_FOLDERS_CLEARED_AT_ONCE = 1_000;

/**
 * Removes folders in {@link clearingOrder} until the workspace is less than
 * `belowShare` full. Only call it while no lease is held, or a running
 * command could lose its folder.
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
 * What in `folders` may be cleared, in order: deleted threads, deleted
 * agents' homes, ended routine runs, remaining agents' caches, then done
 * conversations, last because anything new reopens them. Threads go oldest
 * last turn first. A thread with an active turn is never cleared.
 */
export function clearingOrder(
	workspaceId: string,
	folders: WorkspaceFolders,
): Effect.Effect<readonly Clearable[], never, Database> {
	return Effect.gen(function* () {
		const threads = yield* clearableThreads(workspaceId, folders.threadIds);
		const agents = yield* clearableAgentFolders(workspaceId, folders.agentIds);
		// Stable, keeping threads oldest first within each reason.
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
 * Deleted agents' homes among `agentIds`, and the caches of the rest.
 * Agents never change pods, so an existing one keeps its home.
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
/** Generous, since deleting dependency trees unlinks every file. */
const CLEARING_OPTIONS = { timeout: "2 minutes", maxOutputCharacters: 100_000 } as const;
/**
 * Well inside the timeout, which may kill only the outer command and leave
 * the script deleting while a turn uses the sandbox.
 */
const STOP_REMOVING_AFTER_SECONDS = 90;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_FOLDER = new RegExp(`^${Sandboxes.THREADS_DIRECTORY}/(${ID})$`);
const AGENT_HOME = new RegExp(`^${Sandboxes.AGENTS_DIRECTORY}/(${ID})$`);

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
 * Where clearing moves each path before deleting it, so an interrupted
 * delete never leaves a half-deleted cache in place. The next clearing
 * empties it.
 */
export const SET_ASIDE_DIRECTORY = `${Sandboxes.WORKSPACE_DIRECTORY}/.sugabots-clearing`;

/**
 * Empties {@link SET_ASIDE_DIRECTORY}, then deletes each path while the
 * workspace is at least `belowShare` full, printing each one deleted.
 * Missing paths are skipped, and one that can't be set aside is deleted in
 * place. Stops if `df` fails or after {@link STOP_REMOVING_AFTER_SECONDS}.
 */
function clearingScript(clearables: readonly Clearable[], belowShare: number) {
	return [
		// Read-only folders, like Go's module cache, need write permission to be emptied.
		`delete() { rm -rf -- "$1" 2>/dev/null || { chmod -R u+w -- "$1" && rm -rf -- "$1"; }; }`,
		`set_aside=${SET_ASIDE_DIRECTORY}`,
		`delete "$set_aside"`,
		`mkdir -p -- "$set_aside" || set_aside=`,
		`full() { df -B1 --output=used,avail ${Sandboxes.WORKSPACE_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		"n=0",
		[
			`remove() { [ "$SECONDS" -lt ${STOP_REMOVING_AFTER_SECONDS} ] || exit 0; [ -e "$1" ] || return 0; full || exit 0; n=$((n + 1));`,
			`if [ -n "$set_aside" ] && mv -T -- "$1" "$set_aside/$n"; then delete "$set_aside/$n"; else delete "$1"; fi`,
			`&& printf '%s\\n' "$1"; }`,
		].join(" "),
		...clearables.map((clearable) => `remove ${pathOf(clearable)}`),
	].join("\n");
}
