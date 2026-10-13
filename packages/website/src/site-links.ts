import { siteMeta } from "./site-meta.ts";

/**
 * `worker.ts` redirects this to the current Discord invite, `DISCORD_INVITE`, so
 * every link shows one sugabots.ai address. Keep it free of dots, or
 * `run_worker_first` in `wrangler.jsonc` won't send it to the Worker.
 */
export const DISCORD_PATH = "/discord";

/** Where the site's links point. Change a destination here and every link follows. */
export const siteLinks = {
	docs: "/docs",
	github: "https://github.com/nitrictech/sugabots",
	discord: `${siteMeta.url}${DISCORD_PATH}`,
	getStarted: "#start",
} as const;
