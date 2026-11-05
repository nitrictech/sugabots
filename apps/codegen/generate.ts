/**
 * Regenerates every file the apps copy from the web's packages and the API:
 *
 *     node apps/codegen/generate.ts
 *
 * The apps keep the files they last took until someone runs it, so the web and
 * the API can move on without them. Run it before changing an app: the Native
 * apps workflow's `codegen` tests fail on a change to an app until it has been,
 * and the apps then fail to build wherever they relied on what changed.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as api from "./generate-api.ts";
import { type Generator, targetRoots } from "./generated-files.ts";

/** Every generator, by the script that holds it; a test checks each `generate-*.ts` is here. */
export const generators: Record<string, Generator> = {
	"generate-api.ts": api.generator,
};

if (import.meta.main) {
	for (const [script, generator] of Object.entries(generators)) {
		for (const target of generator.targets) {
			const root = targetRoots[target];
			const { files, folder } = generator.generate(target);
			if (folder) rmSync(root + folder, { recursive: true, force: true });
			for (const [path, contents] of files) {
				mkdirSync(dirname(root + path), { recursive: true });
				writeFileSync(root + path, contents);
			}
			console.log(`${script} (${target}): ${files.size} ${files.size === 1 ? "file" : "files"}`);
		}
	}
}
