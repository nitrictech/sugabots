import { fileURLToPath } from "node:url";

/** The apps generated files are written for, by the folder each one's paths are relative to. */
export const targetRoots = {
	android: fileURLToPath(new URL("../android/", import.meta.url)),
};

export type Target = keyof typeof targetRoots;

export const targets = Object.keys(targetRoots) as Target[];

/**
 * What a generator produces for one app: each file's contents by its path under
 * the app's root, and the folder it owns outright, if any, where a file it no
 * longer produces is stale and removed.
 */
export interface GeneratedFiles {
	files: Map<string, string>;
	folder?: string;
}

/** A generator: the apps it writes files for, and the files it writes for each. */
export interface Generator {
	targets: readonly Target[];
	generate: (target: Target) => GeneratedFiles;
}
