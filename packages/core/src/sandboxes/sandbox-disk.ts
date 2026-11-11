import type { SandboxDiskFolder } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import { Sandboxes } from "./sandboxes.ts";

/** How full a sandbox's disk is, and what its folders take of it. */
export interface DiskUsage {
	readonly usedBytes: number;
	/** What its files can fill: what they use and what is still free to the agents' user. */
	readonly totalBytes: number;
	/**
	 * Largest first; null when they couldn't all be sized, such as when it
	 * took longer than {@link FOLDERS_TIMEOUT}.
	 */
	readonly folders: readonly SandboxDiskFolder[] | null;
}

/** `df` in the sandbox failed, or listed no filesystem it could be read from. */
export class DiskUnmeasurable extends Data.TaggedError("DiskUnmeasurable")<{
	readonly exitCode: number | null;
	readonly stderr: string;
}> {}

/**
 * Measures the sandbox's disk as the agents' user, who fill it. Of the
 * filesystems they write to, the fullest is the one measured, since it runs
 * out first.
 */
export function measureDisk(
	sandbox: Sandboxes.Sandbox,
): Effect.Effect<DiskUsage, Sandboxes.Unavailable | DiskUnmeasurable> {
	return Effect.gen(function* () {
		const filesystems = yield* sandbox.exec(
			`df -B1 --output=used,avail ${WRITTEN_DIRECTORIES.join(" ")}`,
			FILESYSTEMS_OPTIONS,
		);
		const fullest = filesystems.exitCode === 0 ? fullestOf(filesystems.stdout.text) : undefined;
		if (!fullest) {
			return yield* new DiskUnmeasurable({
				exitCode: filesystems.exitCode,
				stderr: filesystems.stderr.text,
			});
		}
		// Run as the agents' user, du skips what it may not read, such as
		// root's files in /tmp; everything under the workspace is theirs.
		const sized = yield* sandbox.exec(
			`shopt -s nullglob; du -sxB1 -- ${Sandboxes.WORKSPACE_DIRECTORY}/agents/* ${Sandboxes.THREADS_DIRECTORY} ${TEMPORARY_DIRECTORY} 2>/dev/null; exit 0`,
			FOLDERS_OPTIONS,
		);
		const timedOut = sized.exitCode === null;
		// Output is kept from its end, so a cut first line would misreport its folder's size.
		if (timedOut || sized.stdout.truncated) return { ...fullest, folders: null };
		const folders = foldersOf(sized.stdout.text);
		// /tmp is always there to size, so sizing nothing means du itself failed.
		return { ...fullest, folders: folders.length === 0 ? null : folders };
	});
}

const TEMPORARY_DIRECTORY = "/tmp";
const WRITTEN_DIRECTORIES = ["/", Sandboxes.WORKSPACE_DIRECTORY, TEMPORARY_DIRECTORY];

const FILESYSTEMS_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 2_000 } as const;
/** Sizing a tree of many small files, such as dependencies, looks up every one of them. */
const FOLDERS_TIMEOUT = "60 seconds";
const FOLDERS_OPTIONS = { timeout: FOLDERS_TIMEOUT, maxOutputCharacters: 20_000 } as const;

/**
 * The fullest of the filesystems `df --output=used,avail` lists. Space kept
 * for root isn't counted, since the agents' user can't fill it.
 */
function fullestOf(listing: string) {
	return listing
		.split("\n")
		.slice(1)
		.flatMap((line) => {
			const [used = Number.NaN, available = Number.NaN] = line.trim().split(/\s+/).map(Number);
			return Number.isSafeInteger(used) && Number.isSafeInteger(available) && used + available > 0
				? [{ usedBytes: used, totalBytes: used + available }]
				: [];
		})
		.reduce<Omit<DiskUsage, "folders"> | undefined>(
			(fullest, next) =>
				!fullest || next.usedBytes / next.totalBytes > fullest.usedBytes / fullest.totalBytes
					? next
					: fullest,
			undefined,
		);
}

const AGENT_HOME = new RegExp(`^${Sandboxes.WORKSPACE_DIRECTORY}/agents/([0-9a-f-]{36})$`);

/** The folders `du -sB1` sized, as `<bytes>\t<path>` lines, largest first. */
function foldersOf(listing: string): SandboxDiskFolder[] {
	return listing
		.split("\n")
		.flatMap((line): SandboxDiskFolder[] => {
			const [size = "", path = ""] = line.split("\t");
			const bytes = Number(size);
			if (size === "" || !Number.isSafeInteger(bytes)) return [];
			if (path === Sandboxes.THREADS_DIRECTORY) return [{ kind: "threads", bytes }];
			if (path === TEMPORARY_DIRECTORY) return [{ kind: "temporary", bytes }];
			const agentId = AGENT_HOME.exec(path)?.[1];
			return agentId ? [{ kind: "home", agentId, bytes }] : [];
		})
		.toSorted((a, b) => b.bytes - a.bytes);
}
