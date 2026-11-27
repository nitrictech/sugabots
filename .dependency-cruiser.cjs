/**
 * Which packages each package may import, from `lint/package-layers.ts`,
 * checked by `bun run lint`, which runs this under Bun so it can read
 * TypeScript.
 *
 * The check only sees imports. It misses two kinds of edge between packages,
 * both allowed today, so check them by hand when changing these rules:
 * - Vite's `import.meta.glob`, as the website reads `packages/docs`'s pages with
 *   in `packages/website/src/docs/pages.ts`.
 * - A `declare module` that adds to another package's types, as
 *   `packages/server/src/auth/middleware.ts` does to the contracts' middleware.
 */
const { mayDependOn } = require("./lint/package-layers.ts");

/** The stored events, which the server's composition root builds the event bus over. */
const eventStore = "packages/core/src/database/events/store\\.ts";

const packageRules = Object.entries(mayDependOn).map(([name, allowed]) => ({
	name: `${name}-imports-only-its-layers`,
	comment: `${name} may import ${allowed.length > 0 ? allowed.join(", ") : "no package of ours"}.`,
	severity: "error",
	from: { path: `^packages/${name}/` },
	to: {
		path: "^packages/",
		pathNot: `^packages/(${[name, ...allowed].join("|")})/`,
	},
}));

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
	forbidden: [
		...packageRules,
		{
			name: "packages-declare-what-they-import",
			comment:
				"Each package resolves only the packages of ours its package.json declares, so one it may not import can't be reached by leaving it out.",
			severity: "error",
			from: { path: "^packages/" },
			to: { couldNotResolve: true, path: "^@sugabots/" },
		},
		{
			name: "entrypoints-call-operations-not-stores",
			comment:
				"The server and the bot loop reach core through its operations and entrypoint services. A store writes without proof, so only core, its tests and the seeds call one.",
			severity: "error",
			from: {
				path: "^packages/(server|bot-loop)/src/",
				pathNot: "(\\.test\\.ts|\\.test-support\\.ts|/testing\\.ts)$",
			},
			to: {
				path: "^packages/core/src/(.*/store/|.*/store\\.ts$|.*[a-z]-store\\.ts$)",
				pathNot: ["/blob-store/", `^${eventStore}$`],
			},
		},
		{
			name: "only-the-server-composes-the-event-store",
			comment:
				"The event store is infrastructure the server's composition root builds the bus over. Nothing else outside core reads or writes it directly.",
			severity: "error",
			from: {
				path: "^packages/(server|bot-loop)/src/",
				pathNot: [
					"^packages/server/src/index\\.ts$",
					"(\\.test\\.ts|\\.test-support\\.ts|/testing\\.ts)$",
				],
			},
			to: { path: `^${eventStore}$` },
		},
	],
	options: {
		// TypeScript 7 has no JavaScript API to parse with, so swc parses, keeping
		// type-only imports as edges. Its syntax tree walker can't read `using`
		// declarations, so the repo doesn't use them.
		parser: "swc",
		doNotFollow: { path: "node_modules" },
		exclude: { path: "(^|/)(node_modules|dist|build|storybook-static)/" },
		combinedDependencies: true,
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "default", "types"],
			extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".d.ts"],
			mainFields: ["module", "main", "types"],
		},
	},
};
