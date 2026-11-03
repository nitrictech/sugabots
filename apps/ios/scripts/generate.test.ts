import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { appRoot, generators } from "./generate.ts";

/** Every file under `folder`, relative to `apps/ios`. */
function filesUnder(folder: string): string[] {
	return readdirSync(appRoot + folder).flatMap((name) => {
		const path = join(appRoot, folder, name);
		if (statSync(path).isDirectory()) return filesUnder(relative(appRoot, path));
		return name === ".DS_Store" ? [] : [relative(appRoot, path)];
	});
}

describe("generated files (run `node apps/ios/scripts/generate.ts`)", () => {
	for (const [script, generate] of Object.entries(generators)) {
		it(`are what ${script} makes now`, () => {
			const { files, folder } = generate();
			for (const [path, contents] of files) {
				expect(readFileSync(appRoot + path, "utf8"), path).toBe(contents);
			}
			if (folder)
				expect(filesUnder(folder).sort()).toEqual(
					[...files.keys()].filter((path) => path.startsWith(folder)).sort(),
				);
		});
	}
});
