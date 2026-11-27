import { posix } from "node:path";
import { Computers } from "../../../computers/computers.ts";
import type { Place } from "./tools.ts";

export function prepareFoldersCommand(place: Place): string {
	const { shellQuoted } = Computers;
	const oldChat = posix.join("/workspace/threads", posix.basename(place.folder));
	const oldHome = posix.join("/workspace/agents", posix.basename(place.home));
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
`;
}
