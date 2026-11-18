import type { RunState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	automationRun,
	bot,
	placedConversation,
	turn,
} from "../database/schema.ts";
import { Computers } from "./computers.ts";

/** Caches in each bot's home that clearing may remove. */
export const BOT_CACHES = [".cache", ".npm", ".bun/install/cache"] as const;

type BotCache = (typeof BOT_CACHES)[number];

/** Something in a computer's workspace that may be cleared, and why. */
type Clearable =
	| {
			readonly reason: "conversation_deleted" | "automation_run_ended" | "conversation_done";
			readonly conversationId: string;
	  }
	| { readonly reason: "bot_deleted"; readonly botId: string }
	| { readonly reason: "bot_cache"; readonly botId: string; readonly cache: BotCache };

type ClearingReason = Clearable["reason"];

export interface Clearing {
	readonly cleared: readonly Clearable[];
	/** Whether it hit its timeout, losing its output, so `cleared` may be missing some. */
	readonly stoppedAtTimeout: boolean;
}

/** Ids of the conversation folders and bot homes in a computer. */
interface WorkspaceFolders {
	readonly conversationIds: readonly string[];
	readonly botIds: readonly string[];
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
	computer: Computers.Computer,
	workspaceId: string,
	belowShare: number,
): Effect.Effect<Clearing, Computers.Unavailable, Database> {
	return Effect.gen(function* () {
		const clearable = yield* clearingOrder(workspaceId, yield* workspaceFoldersIn(computer));
		const order = clearable.slice(0, MAX_FOLDERS_CLEARED_AT_ONCE);
		const clearing = yield* computer.exec(clearingScript(order, belowShare), CLEARING_OPTIONS);
		const cleared = new Set(clearing.stdout.text.split("\n"));
		return {
			cleared: order.filter((folder) => cleared.has(pathOf(folder))),
			stoppedAtTimeout: clearing.exitCode === null,
		};
	});
}

/**
 * What in `folders` may be cleared, in order: deleted conversations, deleted
 * bots' homes, ended automation runs, remaining bots' caches, then done
 * conversations, last because anything new reopens them. Conversations go oldest
 * last turn first. A conversation with an active turn is never cleared.
 */
export function clearingOrder(
	workspaceId: string,
	folders: WorkspaceFolders,
): Effect.Effect<readonly Clearable[], never, Database> {
	return Effect.gen(function* () {
		const conversations = yield* clearableConversations(workspaceId, folders.conversationIds);
		const bots = yield* clearableBotFolders(workspaceId, folders.botIds);
		// Stable, keeping conversations oldest first within each reason.
		return [...conversations, ...bots].toSorted(
			(a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason],
		);
	});
}

const REASON_ORDER: Record<ClearingReason, number> = {
	conversation_deleted: 0,
	bot_deleted: 1,
	automation_run_ended: 2,
	bot_cache: 3,
	conversation_done: 4,
};

function clearableConversations(workspaceId: string, conversationIds: readonly string[]) {
	return Effect.gen(function* () {
		if (conversationIds.length === 0) return [];
		const conversation = alias(placedConversation, "conversation");
		const found = yield* query((db) =>
			db
				.select({
					id: placedConversation.id,
					runState: automationRun.state,
					conversationDoneAt: conversation.doneAt,
					activeTurns:
						sql<number>`count(*) filter (where ${inArray(turn.status, [...ACTIVE_TURN_STATUSES])})`.mapWith(
							Number,
						),
				})
				.from(placedConversation)
				.leftJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
				.leftJoin(automationRun, eq(automationRun.conversationId, placedConversation.id))
				.leftJoin(turn, eq(turn.conversationId, placedConversation.id))
				.where(
					and(
						eq(placedConversation.workspaceId, workspaceId),
						inArray(placedConversation.id, [...conversationIds]),
					),
				)
				.groupBy(placedConversation.id, conversation.doneAt, automationRun.state)
				.orderBy(sql`max(${turn.startedAt}) nulls first`),
		);
		const existing = new Set(found.map((row) => row.id));
		const deleted = conversationIds
			.filter((conversationId) => !existing.has(conversationId))
			.map((conversationId): Clearable => ({ conversationId, reason: "conversation_deleted" }));
		const finished = found
			.filter((row) => row.activeTurns === 0)
			.flatMap((row): Clearable[] => {
				if (row.runState && ENDED_RUN_STATES.has(row.runState)) {
					return [{ conversationId: row.id, reason: "automation_run_ended" }];
				}
				if (row.conversationDoneAt)
					return [{ conversationId: row.id, reason: "conversation_done" }];
				return [];
			});
		return [...deleted, ...finished];
	});
}

const ENDED_RUN_STATES: ReadonlySet<RunState> = new Set(["completed", "failed", "cancelled"]);

/**
 * Deleted bots' homes among `botIds`, and the caches of the rest.
 * An existing bot keeps its home for as long as it exists.
 */
function clearableBotFolders(workspaceId: string, botIds: readonly string[]) {
	return Effect.gen(function* () {
		if (botIds.length === 0) return [];
		const found = yield* query((db) =>
			db
				.select({ id: bot.id })
				.from(bot)
				.where(and(eq(bot.workspaceId, workspaceId), inArray(bot.id, [...botIds]))),
		);
		const existing = new Set(found.map((row) => row.id));
		return botIds.flatMap((botId): Clearable[] =>
			existing.has(botId)
				? BOT_CACHES.map((cache) => ({ botId, cache, reason: "bot_cache" }))
				: [{ botId, reason: "bot_deleted" }],
		);
	});
}

function pathOf(clearable: Clearable) {
	switch (clearable.reason) {
		case "conversation_deleted":
		case "automation_run_ended":
		case "conversation_done":
			return `${Computers.CONVERSATIONS_DIRECTORY}/${clearable.conversationId}`;
		case "bot_deleted":
			return `${Computers.BOTS_DIRECTORY}/${clearable.botId}`;
		case "bot_cache":
			return `${Computers.BOTS_DIRECTORY}/${clearable.botId}/${clearable.cache}`;
	}
}

const LISTING_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 200_000 } as const;
/** Generous, since deleting dependency trees unlinks every file. */
const CLEARING_OPTIONS = { timeout: "2 minutes", maxOutputCharacters: 100_000 } as const;
/**
 * Well inside the timeout, which may kill only the outer command and leave
 * the script deleting while a turn uses the computer.
 */
const STOP_REMOVING_AFTER_SECONDS = 90;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_FOLDER = new RegExp(`^${Computers.CONVERSATIONS_DIRECTORY}/(${ID})$`);
const BOT_HOME = new RegExp(`^${Computers.BOTS_DIRECTORY}/(${ID})$`);

function workspaceFoldersIn(computer: Computers.Computer) {
	return Effect.map(
		computer.exec(
			`find ${Computers.CONVERSATIONS_DIRECTORY} ${Computers.BOTS_DIRECTORY} -mindepth 1 -maxdepth 1 -type d 2>/dev/null; exit 0`,
			LISTING_OPTIONS,
		),
		(listing): WorkspaceFolders => {
			const paths = listing.stdout.text.split("\n");
			return {
				conversationIds: paths.flatMap((path) => CONVERSATION_FOLDER.exec(path)?.[1] ?? []),
				botIds: paths.flatMap((path) => BOT_HOME.exec(path)?.[1] ?? []),
			};
		},
	);
}

/**
 * Where clearing moves each path before deleting it, so an interrupted
 * delete never leaves a half-deleted cache in place. The next clearing
 * empties it.
 */
export const SET_ASIDE_DIRECTORY = `${Computers.WORKSPACE_DIRECTORY}/.sugabots-clearing`;

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
		`full() { df -B1 --output=used,avail ${Computers.WORKSPACE_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		"n=0",
		[
			`remove() { [ "$SECONDS" -lt ${STOP_REMOVING_AFTER_SECONDS} ] || exit 0; [ -e "$1" ] || return 0; full || exit 0; n=$((n + 1));`,
			`if [ -n "$set_aside" ] && mv -T -- "$1" "$set_aside/$n"; then delete "$set_aside/$n"; else delete "$1"; fi`,
			`&& printf '%s\\n' "$1"; }`,
		].join(" "),
		...clearables.map((clearable) => `remove ${pathOf(clearable)}`),
	].join("\n");
}
