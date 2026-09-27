import type { BotLook } from "@sugabots/avatars";
import { bots } from "@/landing/bots";

/** Someone in a demo chat: a person drawn with their initials, or a bot with its face. */
export type CastMember =
	| { kind: "person"; name: string; initials: string }
	| { kind: "self"; name: string }
	| { kind: "bot"; name: string; look: BotLook };

/** Everyone the docs' demo chats can put words in the mouth of. The landing page's bots, plus the family who use them. */
export const cast = {
	you: { kind: "self", name: "You" },
	mum: { kind: "person", name: "Mum", initials: "MA" },
	dad: { kind: "person", name: "Dad", initials: "DA" },
	sam: { kind: "person", name: "Sam", initials: "SA" },
	tripPlanner: { kind: "bot", name: "Trip Planner", look: bots.tripPlanner },
	budgetKeeper: { kind: "bot", name: "Budget Keeper", look: bots.budgetKeeper },
	copywriter: { kind: "bot", name: "Copywriter", look: bots.copywriter },
	researcher: { kind: "bot", name: "Researcher", look: bots.researcher },
	inboxSorter: { kind: "bot", name: "Inbox Sorter", look: bots.inboxSorter },
	journal: { kind: "bot", name: "Journal", look: bots.journal },
} as const satisfies Record<string, CastMember>;

export type CastName = keyof typeof cast;
