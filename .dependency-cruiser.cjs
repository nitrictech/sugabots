/**
 * Which packages each package may import, checked by `bun run lint`.
 *
 * From the bottom: `errors` and `workflow` import no package of ours;
 * `contracts` only `errors`; `core` the shared packages beneath it; the bot
 * loop core; the server the bot loop and core; and the web app only the SDK,
 * the contracts and the packages that draw. Core starts turns without knowing
 * the bot loop: it declares the services that start and signal turns, and the
 * server provides them from `@sugabots/bot-loop`.
 */

/** Packages the web app, the website and other front ends may share with anything. */
const drawing = ["avatars", "emoji", "provider-logos", "docs"];

/** Each package, and the packages of ours it may import. */
const mayImport = {
	errors: [],
	workflow: [],
	accounting: [],
	emoji: [],
	contracts: ["errors", "emoji"],
	avatars: ["contracts"],
	docs: ["contracts"],
	"provider-logos": ["contracts"],
	core: ["accounting", "avatars", "contracts", "docs", "errors", "workflow"],
	"bot-loop": ["contracts", "core", "errors", "workflow"],
	server: ["bot-loop", "contracts", "core", "errors", "workflow"],
	demo: ["contracts", "core", "errors", "server"],
	sdk: ["contracts", "errors"],
	web: ["sdk", "contracts", "errors", ...drawing],
	website: ["contracts", ...drawing],
};

const packageRules = Object.entries(mayImport).map(([name, allowed]) => ({
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
			to: { path: "^packages/core/src/(.*/store/|.*[a-z]-store\\.ts$)", pathNot: "/blob-store/" },
		},
	],
	options: {
		// TypeScript 7 has no JavaScript API to parse with, so Babel strips the types.
		// dependency-cruiser only scans .ts files when it finds a TypeScript or swc it
		// supports, which is why `@swc/core` is a dev dependency though nothing calls it:
		// without it, every .ts file is skipped and the rules pass having checked nothing.
		babelConfig: { fileName: "lint/dependency-cruiser.babel.json" },
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
