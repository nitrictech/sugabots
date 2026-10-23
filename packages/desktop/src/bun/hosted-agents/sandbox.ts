import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LentAgent } from "../local-agents.ts";

/**
 * Confines a lent agent's program to its folder with bubblewrap, on Linux:
 * it sees the system read-only, its own folder read-write, and of the home
 * directory only the program's own settings and state, so the rest of the
 * person's files (keys, other projects, browser profiles) are out of reach.
 * It keeps its own processes, IPC and `/tmp`, and a session of its own, so it
 * can't type into the terminal that started this app.
 *
 * It shares the network: the program has to reach its model provider, and
 * opencode this app's loopback tool server.
 */

/** Where bubblewrap is, on a Linux that has it; nothing elsewhere, where agents run unconfined. */
export const BWRAP = process.platform === "linux" ? Bun.which("bwrap") : null;

/** The system, read-only: what any program needs to run, on NixOS and on other distributions. */
const SYSTEM_PATHS = [
	"/nix",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/etc",
	"/opt",
	"/run/current-system",
	"/run/wrappers",
	// Where /etc/resolv.conf points on systemd-resolved systems.
	"/run/systemd/resolve",
];

/** Each program's settings, login and state under the home directory, which it reads and writes. */
const OWN_STATE: Record<LentAgent["kind"], ReadonlyArray<string>> = {
	"claude-code": [".claude", ".claude.json", ".config/claude"],
	opencode: [
		".config/opencode",
		".local/share/opencode",
		".local/state/opencode",
		".cache/opencode",
	],
};

/** Read-only, for any program: who the person is to git. */
const SHARED_READ_ONLY = [".gitconfig", ".config/git"];

/**
 * `command`, run confined to `workingDirectory` as `kind`'s program, or as it
 * is where there's no bubblewrap.
 */
export function confined(
	command: ReadonlyArray<string>,
	{ kind, workingDirectory }: { kind: LentAgent["kind"]; workingDirectory: string },
): string[] {
	if (!BWRAP) return [...command];
	const home = homedir();
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		...SYSTEM_PATHS.flatMap((path) => ["--ro-bind-try", path, path]),
		// An empty home, then only what the program needs in it.
		"--tmpfs",
		home,
		...SHARED_READ_ONLY.flatMap((path) => ["--ro-bind-try", join(home, path), join(home, path)]),
		...OWN_STATE[kind].flatMap((path) => ["--bind-try", join(home, path), join(home, path)]),
		// A program installed outside the system, such as under the home directory.
		...installRoots(command[0]).flatMap((path) => ["--ro-bind-try", path, path]),
		"--bind",
		workingDirectory,
		workingDirectory,
		"--chdir",
		workingDirectory,
		"--",
		...command,
	];
	return [BWRAP, ...args];
}

/**
 * The folders a program's executable lives in, two levels up from where its
 * links lead, which covers a package installed with its files beside it.
 */
function installRoots(executable: string | undefined): string[] {
	if (!executable) return [];
	try {
		const real = realpathSync(executable);
		return [dirname(dirname(real))];
	} catch {
		return [];
	}
}
