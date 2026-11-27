/**
 * Which packages each package may depend on: what its `package.json`
 * declares and what its code imports. `.dependency-cruiser.cjs` checks the
 * imports and `check-package-manifests.ts` the declarations, both by `bun run lint`.
 *
 * From the bottom: `errors` and `workflow` depend on no package of ours;
 * `contracts` only `errors`; `core` the shared packages beneath it; the bot
 * loop core; the server the bot loop and core; and the web app only the SDK,
 * the contracts and the packages that draw. Core starts turns without knowing
 * the bot loop: it declares the services that start and signal turns, and the
 * server provides them from `@sugabots/bot-loop`.
 */

/** Packages the web app, the website and other front ends may share with anything. */
const drawing = ["avatars", "emoji", "provider-logos", "docs"];

/** Each package, by its directory under `packages/`, and the packages of ours it may depend on. */
export const mayDependOn: Readonly<Record<string, readonly string[]>> = {
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
