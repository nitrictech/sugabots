import type { BotLook } from "@sugabots/avatars";

/** The cast of bots the landing page shows off. */
export const bots = {
	tripPlanner: { color: "sky", face: "bar" },
	budgetKeeper: { color: "yellow", face: "square" },
	copywriter: { color: "purple", face: "smile" },
	researcher: { color: "cyan", face: "smile" },
	inboxSorter: { color: "yellow", face: "bar" },
	journal: { color: "teal", face: "dots" },
} satisfies Record<string, BotLook>;
