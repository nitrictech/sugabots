import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Where `core` and `server` live, the base the paths below are relative to. */
const PACKAGES = join(import.meta.dirname, "../..");

/**
 * The TypeScript files core and the server ship, as paths relative to
 * `packages/` (`core/src/…`), leaving out tests and their fixtures.
 */
export function shippedSourceFiles(): Array<{ path: string; absolute: string }> {
	return ["core/src", "server/src"].flatMap((root) =>
		readdirSync(join(PACKAGES, root), { recursive: true, encoding: "utf8" })
			.filter(
				(name) =>
					name.endsWith(".ts") &&
					!name.endsWith(".test.ts") &&
					!name.endsWith(".test-support.ts") &&
					!name.endsWith("testing.ts") &&
					!name.split("/").includes("node_modules"),
			)
			.map((name) => {
				const absolute = join(PACKAGES, root, name);
				return { path: relative(PACKAGES, absolute), absolute };
			}),
	);
}
