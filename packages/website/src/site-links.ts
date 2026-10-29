import { projectLinks } from "@sugabots/contracts/project-links";

/**
 * `worker.ts` redirects this to the current Discord invite, `DISCORD_INVITE`, so
 * every link shows one sugabots.ai address. Keep it free of dots, or
 * `run_worker_first` in `wrangler.jsonc` won't send it to the Worker.
 */
export const DISCORD_PATH = new URL(projectLinks.discord).pathname;

/** Where the site's links point. Change a destination here and every link follows. */
export const siteLinks = {
	docs: "/docs",
	selfHost: "/docs/quickstart",
	/** The waitlist form in the landing page's Hosted plan, from any page. */
	waitlist: "/#waitlist",
	github: projectLinks.repository,
	discord: projectLinks.discord,
} as const;
