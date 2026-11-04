import { fileURLToPath } from "node:url";

/** The apps generated files are written for, by the folder each one's paths are relative to. */
export const targetRoots = {
	ios: fileURLToPath(new URL("../", import.meta.url)),
	android: fileURLToPath(new URL("../../android/", import.meta.url)),
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

/**
 * A generator: the model it reads from the web's packages or the API, and how
 * each app it serves writes that model out.
 */
export interface Generator<Model> {
	model: () => Model;
	emitters: Partial<Record<Target, (model: Model) => GeneratedFiles>>;
}

/** A generator whose model's type is its own business, so generators of every model sit in one list. */
export interface RegisteredGenerator {
	targets: Target[];
	generate: (target: Target) => GeneratedFiles;
}

export function register<Model>({ model, emitters }: Generator<Model>): RegisteredGenerator {
	return {
		targets: targets.filter((target) => emitters[target]),
		generate(target) {
			const emit = emitters[target];
			if (!emit) throw new Error(`This generator writes nothing for ${target}.`);
			return emit(model());
		},
	};
}

/** A generator that only the iOS app has yet, which reads its sources as it writes. */
export function iosOnly(generate: () => GeneratedFiles): RegisteredGenerator {
	return register({ model: () => undefined, emitters: { ios: generate } });
}
