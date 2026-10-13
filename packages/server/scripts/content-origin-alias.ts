import { spawnSync } from "node:child_process";

/*
 * Under `bun run dev`, Portless serves the API at a `.localhost` name and
 * gives it a fresh PORT each run. Pages are served from CONTENT_ORIGIN, a name
 * of its own on the same server, so that name is registered with Portless as
 * an alias to this run's port. Anything else is left alone: a run outside
 * Portless, no CONTENT_ORIGIN, or one that isn't a `.localhost` name.
 */

const LOCALHOST_SUFFIX = ".localhost";

const { PORTLESS_URL, PORT, CONTENT_ORIGIN } = process.env;
const hostname = CONTENT_ORIGIN ? new URL(CONTENT_ORIGIN).hostname : undefined;

if (PORTLESS_URL && PORT && hostname?.endsWith(LOCALHOST_SUFFIX)) {
	const name = hostname.slice(0, -LOCALHOST_SUFFIX.length);
	const alias = spawnSync("bunx", ["portless", "alias", name, PORT, "--force"], {
		stdio: "inherit",
	});
	// A missing alias only stops pages loading, so the server starts regardless.
	if (alias.status !== 0) console.warn(`Could not register ${hostname} with Portless.`);
}
