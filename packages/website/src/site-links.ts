/**
 * Whether the GitHub repo and docs are public. Until then, links to them are
 * hidden and visitors are asked to register interest by email. Build with
 * `VITE_LAUNCHED=true` to switch.
 */
export const launched = import.meta.env.VITE_LAUNCHED === "true";

const EARLY_ACCESS_ADDRESS = "bots@suga.app";
const EARLY_ACCESS_SUBJECT = "I want to try Sugabots";
const EARLY_ACCESS_BODY = "Let me know when it's ready, I want to try Sugabots.";

/** Where the site's links point. Change a destination here and every link follows. */
export const siteLinks = {
	docs: "https://docs.sugabots.ai",
	github: "https://github.com/nitrictech/sugabots",
	discord: "https://suga.app/chat",
	getStarted: "#start",
	earlyAccess: `mailto:${EARLY_ACCESS_ADDRESS}?subject=${encodeURIComponent(EARLY_ACCESS_SUBJECT)}&body=${encodeURIComponent(EARLY_ACCESS_BODY)}`,
} as const;
