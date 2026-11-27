import { posix } from "node:path";
import type { RunState } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	automationRun,
	bot,
	computerFolderMove,
	placedChat,
	turn,
} from "../database/schema.ts";
import { Computers } from "./computers.ts";

/** Caches in each bot's home that clearing may remove. */
export const BOT_CACHES = [".cache", ".npm", ".bun/install/cache"] as const;

type BotCache = (typeof BOT_CACHES)[number];

/** Something in a computer's work directory that may be cleared, and why. */
type Clearable =
	| {
			readonly reason: "chat_deleted" | "automation_run_ended" | "chat_resolved";
			readonly chatId: string;
	  }
	| { readonly reason: "bot_deleted"; readonly botId: string }
	| { readonly reason: "bot_cache"; readonly botId: string; readonly cache: BotCache };

type ClearingReason = Clearable["reason"];

export interface Clearing {
	readonly cleared: readonly Clearable[];
	/** Whether it hit its timeout, losing its output, so `cleared` may be missing some. */
	readonly stoppedAtTimeout: boolean;
}

interface WorkFolders {
	readonly chats: ReadonlyMap<string, readonly string[]>;
	readonly homes: ReadonlyMap<string, readonly string[]>;
}

/**
 * Linux caps the script, a single bash argument, at 128 KiB, and each
 * folder adds up to 85 bytes. The rest wait for the next clearing.
 */
const MAX_FOLDERS_CLEARED_AT_ONCE = 1_000;

/**
 * Finds what can be deleted, in {@link clearingOrder}, and returns the
 * separate effect that removes those folders while the work directory's disk
 * is at least `belowShare` full. Only run it while no lease is held, or a
 * running command could lose its folder.
 */
export function prepareDiskClearing(
	computer: Pick<Computers.Computer, "exec">,
	workspaceId: string,
	belowShare: number,
) {
	return Effect.gen(function* () {
		const folders = yield* workFoldersIn(computer);
		const clearable = yield* clearingOrder(workspaceId, folders);
		const order = clearable
			.flatMap((folder) => {
				const paths =
					"chatId" in folder ? folders.chats.get(folder.chatId) : folders.homes.get(folder.botId);
				return (paths ?? []).map((path) => ({
					folder,
					path: folder.reason === "bot_cache" ? `${path}/${folder.cache}` : path,
				}));
			})
			.slice(0, MAX_FOLDERS_CLEARED_AT_ONCE);
		return computer
			.exec(
				clearingScript(
					order.map(({ path }) => path),
					belowShare,
				),
				CLEARING_OPTIONS,
			)
			.pipe(
				Effect.map((clearing): Clearing => {
					const cleared = new Set(clearing.stdout.text.split("\n"));
					return {
						cleared: order.flatMap(({ folder, path }) => (cleared.has(path) ? [folder] : [])),
						stoppedAtTimeout: clearing.exitCode === null,
					};
				}),
			);
	});
}

/**
 * What in `folders` may be cleared, in order: deleted chats, deleted
 * bots' homes, ended automation runs, remaining bots' caches, then resolved
 * chats, last because anything new reopens them. Chats go oldest
 * last turn first. A chat with an active turn is never cleared.
 */
function clearingOrder(
	workspaceId: string,
	folders: WorkFolders,
): Effect.Effect<readonly Clearable[], never, Database> {
	return Effect.gen(function* () {
		const chats = yield* clearableChats(workspaceId, [...folders.chats.keys()]);
		const bots = yield* clearableBotFolders(workspaceId, [...folders.homes.keys()]);
		// Stable, keeping chats oldest first within each reason.
		return [...chats, ...bots].toSorted((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason]);
	});
}

const REASON_ORDER: Record<ClearingReason, number> = {
	chat_deleted: 0,
	bot_deleted: 1,
	automation_run_ended: 2,
	bot_cache: 3,
	chat_resolved: 4,
};

function clearableChats(workspaceId: string, chatIds: readonly string[]) {
	return Effect.gen(function* () {
		if (chatIds.length === 0) return [];
		const chat = alias(placedChat, "chat");
		const found = yield* query((db) =>
			db
				.select({
					id: placedChat.id,
					runState: automationRun.state,
					chatResolvedAt: chat.resolvedAt,
					activeTurns:
						sql<number>`count(*) filter (where ${inArray(turn.status, [...ACTIVE_TURN_STATUSES])})`.mapWith(
							Number,
						),
				})
				.from(placedChat)
				.leftJoin(chat, eq(chat.id, placedChat.rootChatId))
				.leftJoin(automationRun, eq(automationRun.chatId, placedChat.id))
				.leftJoin(turn, eq(turn.chatId, placedChat.id))
				.where(and(eq(placedChat.workspaceId, workspaceId), inArray(placedChat.id, [...chatIds])))
				.groupBy(placedChat.id, chat.resolvedAt, automationRun.state)
				.orderBy(sql`max(${turn.startedAt}) nulls first`),
		);
		const existing = new Set(found.map((row) => row.id));
		const pendingMoves = yield* query((db) =>
			db
				.select({ id: computerFolderMove.fromChatId })
				.from(computerFolderMove)
				.innerJoin(placedChat, eq(placedChat.id, computerFolderMove.toChatId))
				.where(
					and(
						eq(placedChat.workspaceId, workspaceId),
						inArray(computerFolderMove.fromChatId, [...chatIds]),
					),
				),
		);
		const preserved = new Set(pendingMoves.map(({ id }) => id));
		const deleted = chatIds
			.filter((chatId) => !existing.has(chatId) && !preserved.has(chatId))
			.map((chatId): Clearable => ({ chatId, reason: "chat_deleted" }));
		const finished = found
			.filter((row) => row.activeTurns === 0)
			.flatMap((row): Clearable[] => {
				if (row.runState && ENDED_RUN_STATES.has(row.runState)) {
					return [{ chatId: row.id, reason: "automation_run_ended" }];
				}
				if (row.chatResolvedAt) return [{ chatId: row.id, reason: "chat_resolved" }];
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

const LISTING_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 200_000 } as const;
/** Generous, since deleting dependency trees unlinks every file. */
const CLEARING_OPTIONS = { timeout: "2 minutes", maxOutputCharacters: 100_000 } as const;
/**
 * Well inside the timeout, which may kill only the outer command and leave
 * the script deleting while a turn uses the computer.
 */
const STOP_REMOVING_AFTER_SECONDS = 90;

function workFoldersIn(computer: Pick<Computers.Computer, "exec">) {
	const roots = [...Computers.CHAT_DIRECTORIES, ...Computers.BOT_DIRECTORIES].join(" ");
	return Effect.map(
		computer.exec(
			`find ${roots} -mindepth 1 -maxdepth 1 -type d 2>/dev/null; exit 0`,
			LISTING_OPTIONS,
		),
		(listing): WorkFolders => {
			const paths = listing.stdout.text.split("\n");
			return {
				chats: Map.groupBy(
					paths.filter((path) => Computers.CHAT_FOLDER.test(path)),
					(path) => posix.basename(path),
				),
				homes: Map.groupBy(
					paths.filter((path) => Computers.HOME_FOLDER.test(path)),
					(path) => posix.basename(path),
				),
			};
		},
	);
}

/**
 * Where clearing moves each path before deleting it, so an interrupted
 * delete never leaves a half-deleted cache in place. The next clearing
 * empties it.
 */
export const SET_ASIDE_DIRECTORY = `${Computers.WORK_DIRECTORY}/.sugabots-clearing`;

/**
 * Empties {@link SET_ASIDE_DIRECTORY}, then deletes each path while the
 * work directory's disk is at least `belowShare` full, printing each one deleted.
 * Missing paths are skipped, and one that can't be set aside is deleted in
 * place. Stops if `df` fails or after {@link STOP_REMOVING_AFTER_SECONDS}.
 */
function clearingScript(paths: readonly string[], belowShare: number) {
	return [
		// Read-only folders, like Go's module cache, need write permission to be emptied.
		`delete() { rm -rf -- "$1" 2>/dev/null || { chmod -R u+w -- "$1" && rm -rf -- "$1"; }; }`,
		`set_aside=${SET_ASIDE_DIRECTORY}`,
		`delete "$set_aside"`,
		`mkdir -p -- "$set_aside" || set_aside=`,
		`full() { df -B1 --output=used,avail ${Computers.WORK_DIRECTORY} | awk -v share=${belowShare} 'NR == 2 { full = $1 >= ($1 + $2) * share } END { exit !full }'; }`,
		"n=0",
		[
			`remove() { [ "$SECONDS" -lt ${STOP_REMOVING_AFTER_SECONDS} ] || exit 0; [ -e "$1" ] || return 0; full || exit 0; n=$((n + 1));`,
			`if [ -n "$set_aside" ] && mv -T -- "$1" "$set_aside/$n"; then delete "$set_aside/$n"; else delete "$1"; fi`,
			`&& printf '%s\\n' "$1"; }`,
		].join(" "),
		...paths.map((path) => `remove ${path}`),
	].join("\n");
}
