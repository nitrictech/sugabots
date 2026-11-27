import { posix } from "node:path";
import { eq } from "drizzle-orm";
import { Array as Arr, Effect } from "effect";
import { Computers } from "../../../computers/computers.ts";
import { query } from "../../../database/database.ts";
import { computerFolderMove } from "../../../database/schema.ts";
import { type Place, placeOf } from "./tools.ts";

export function loadComputerPlace(turn: { chatId: string; botId: string }) {
	return query((db) =>
		db
			.select({ id: computerFolderMove.fromChatId })
			.from(computerFolderMove)
			.where(eq(computerFolderMove.toChatId, turn.chatId)),
	).pipe(
		Effect.map((rows): Place => ({ ...placeOf(turn), previousChatIds: rows.map(({ id }) => id) })),
	);
}

// A batch of 1,000 quoted UUIDs fits in one argument to bash -c on Linux.
const CHAT_FOLDERS_PER_COMMAND = 1_000;

export const execWithPreparedFolders = Effect.fnUntraced(function* (
	computer: Computers.Computer,
	place: Place,
	options: Computers.ExecOptions,
	command = "",
) {
	const batches = Arr.chunksOf(place.previousChatIds, CHAT_FOLDERS_PER_COMMAND);
	const last = batches.pop() ?? [];
	for (const batch of batches) {
		const ran = yield* computer.exec(prepareFoldersCommand(place, batch), options);
		if (ran.exitCode !== 0) return ran;
	}
	return yield* computer.exec(prepareFoldersCommand(place, last) + command, options);
});

function prepareFoldersCommand(place: Place, previousChatIds: readonly string[]): string {
	const { shellQuoted } = Computers;
	const oldChat = posix.join(Computers.LEGACY_CHATS_DIRECTORY, posix.basename(place.folder));
	const oldHome = posix.join(Computers.LEGACY_BOTS_DIRECTORY, posix.basename(place.home));
	const collaborations = posix.join(place.folder, "collaborations");
	return `
move_folder_contents() (
	[ ! -L "$2" ] && mkdir -p -- "$2" || exit 1
	[ -d "$1" ] && [ ! -L "$1" ] || exit 0
	for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
		[ -e "$entry" ] || [ -L "$entry" ] || continue
		destination="$2/\${entry##*/}"
		if [ -e "$destination" ] || [ -L "$destination" ]; then
			if [ -d "$entry" ] && [ ! -L "$entry" ] && [ -d "$destination" ] && [ ! -L "$destination" ]; then
				move_folder_contents "$entry" "$destination" || exit 1
			fi
			continue
		fi
		mv -n -- "$entry" "$2/" ||
			{ [ ! -e "$entry" ] && [ ! -L "$entry" ]; } ||
			[ -e "$destination" ] || [ -L "$destination" ] || exit 1
	done
	rmdir -- "$1" 2>/dev/null || :
)
move_folder_contents ${shellQuoted(oldChat)} ${shellQuoted(place.folder)} || exit 1
move_folder_contents ${shellQuoted(oldHome)} ${shellQuoted(place.home)} || exit 1
move_collaboration_folder() {
	[ -d "$1" ] && [ ! -L "$1" ] || return 0
	[ ! -L ${shellQuoted(collaborations)} ] && move_folder_contents "$1" "$2"
}
for chat_id in ${previousChatIds.map(shellQuoted).join(" ")}; do
	move_collaboration_folder ${shellQuoted(Computers.LEGACY_CHATS_DIRECTORY)}/"$chat_id" ${shellQuoted(collaborations)}/"$chat_id" || exit 1
	move_collaboration_folder ${shellQuoted(Computers.CHATS_DIRECTORY)}/"$chat_id" ${shellQuoted(collaborations)}/"$chat_id-chats" || exit 1
done
`;
}
