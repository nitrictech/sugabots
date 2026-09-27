/**
 * Whether the GitHub repo and docs are public. Until then, links to them are
 * hidden and visitors are pointed to the Discord to hear about the launch.
 * Build with `VITE_LAUNCHED=true` to switch.
 */
export const launched = import.meta.env.VITE_LAUNCHED === "true";

/** Where the site's links point. Change a destination here and every link follows. */
export const siteLinks = {
	docs: "/docs",
	github: "https://github.com/nitrictech/sugabots",
	discord: "https://discord.gg/YPuHCVAsx",
	getStarted: "#start",
} as const;
