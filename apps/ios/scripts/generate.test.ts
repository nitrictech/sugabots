import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { generators } from "./generate.ts";
import { targetRoots, targets } from "./generated-files.ts";

/** Every file under `folder`, relative to `root`. */
function filesUnder(root: string, folder: string): string[] {
	return readdirSync(root + folder).flatMap((name) => {
		const path = join(root, folder, name);
		if (statSync(path).isDirectory()) return filesUnder(root, relative(root, path));
		return name === ".DS_Store" ? [] : [relative(root, path)];
	});
}

for (const target of targets) {
	const root = targetRoots[target];
	const serving = Object.entries(generators).filter(([, generator]) =>
		generator.targets.includes(target),
	);
	if (serving.length === 0) continue;
	describe(`${target}'s generated files (run \`node apps/ios/scripts/generate.ts\`)`, () => {
		for (const [script, generator] of serving) {
			it(`are what ${script} makes now`, () => {
				const { files, folder } = generator.generate(target);
				for (const [path, contents] of files) {
					expect(readFileSync(root + path, "utf8"), path).toBe(contents);
				}
				if (folder)
					expect(filesUnder(root, folder).sort()).toEqual(
						[...files.keys()].filter((path) => path.startsWith(folder)).sort(),
					);
			});
		}
	});
}
