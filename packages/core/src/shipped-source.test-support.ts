import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

/** Where `core` and `server` live, the base the paths below are relative to. */
const PACKAGES = join(import.meta.dirname, "../..");

/**
 * The TypeScript files core and the server ship, as paths relative to
 * `packages/` (`core/src/…`) with forward slashes on every OS, leaving out
 * tests and their fixtures.
 */
export function shippedSourceFiles(): Array<{ path: string; absolute: string }> {
	return ["core/src", "server/src"].flatMap((root) =>
		readdirSync(join(PACKAGES, root), { recursive: true, encoding: "utf8" })
			.map((name) => name.split(sep).join("/"))
			.filter(
				(name) =>
					name.endsWith(".ts") &&
					!name.endsWith(".test.ts") &&
					!name.endsWith(".test-support.ts") &&
					!name.endsWith("testing.ts") &&
					!name.split("/").includes("node_modules"),
			)
			.map((name) => ({ path: `${root}/${name}`, absolute: join(PACKAGES, root, name) })),
	);
}
