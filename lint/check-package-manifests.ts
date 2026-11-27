/**
 * Checks that each package's `package.json` declares only the packages of
 * ours that `package-layers.ts` lets it depend on. dependency-cruiser checks
 * the same table against imports, so this catches what it can't see: a
 * dependency declared and not yet imported, such as `core` on `bot-loop`.
 *
 * `node lint/check-package-manifests.ts` fails if any package declares one,
 * listing which.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mayDependOn } from "./package-layers.ts";

const PACKAGES = join(import.meta.dirname, "..", "packages");
const OUR_SCOPE = "@sugabots/";
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

type Manifest = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

const problems = readdirSync(PACKAGES).flatMap((name) => {
	const file = join(PACKAGES, name, "package.json");
	if (!existsSync(file)) return [];
	const allowed = mayDependOn[name];
	if (!allowed) return [`packages/${name} isn't in lint/package-layers.ts`];
	const manifest: Manifest = JSON.parse(readFileSync(file, "utf8"));
	return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}))
		.filter((dependency) => dependency.startsWith(OUR_SCOPE))
		.map((dependency) => dependency.slice(OUR_SCOPE.length))
		.filter((dependency) => dependency !== name && !allowed.includes(dependency))
		.map(
			(dependency) =>
				`packages/${name}/package.json declares ${OUR_SCOPE}${dependency}, which ${name} may not depend on`,
		);
});

if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	process.exit(1);
}
