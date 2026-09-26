import type { BotLook } from "@sugabots/avatars";

/** The cast of bots the landing page shows off. */
export const bots = {
	tripPlanner: { color: "sky", face: "pill" },
	budgetKeeper: { color: "yellow", face: "square" },
	copywriter: { color: "purple", face: "arc" },
	researcher: { color: "ice", face: "arc" },
	inboxSorter: { color: "yellow", face: "pill" },
	journal: { color: "teal", face: "dot" },
} satisfies Record<string, BotLook>;
