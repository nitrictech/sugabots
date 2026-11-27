import { posix } from "node:path";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
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

export function prepareFoldersCommand(place: Place): string {
	const { shellQuoted } = Computers;
	const oldChat = posix.join(Computers.LEGACY_CHATS_DIRECTORY, posix.basename(place.folder));
	const oldHome = posix.join(Computers.LEGACY_BOTS_DIRECTORY, posix.basename(place.home));
	const collaborations = posix.join(place.folder, "collaborations");
	const moves = place.previousChatIds.flatMap((chatId) =>
		(
			[
				[Computers.LEGACY_CHATS_DIRECTORY, chatId],
				[Computers.CHATS_DIRECTORY, `${chatId}-chats`],
			] as const
		).map(([directory, name]) => {
			const source = shellQuoted(posix.join(directory, chatId));
			const destination = shellQuoted(posix.join(collaborations, name));
			return `if [ -d ${source} ] && [ ! -L ${source} ]; then
	[ ! -L ${shellQuoted(collaborations)} ] && move_folder_contents ${source} ${destination} || exit 1
fi`;
		}),
	);
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
${moves.join("\n")}
`;
}
