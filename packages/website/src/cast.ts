import type { ChatAuthor } from "@/components/chat";

/**
 * Everyone the landing page's and the docs' demo conversations put words in
 * the mouth of. The portraits are from Unsplash; see the README.
 */
export const cast = {
	you: { kind: "person", name: "You", initials: "Y" },
	mum: { kind: "person", name: "Mum", initials: "MA" },
	dad: { kind: "person", name: "Dad", initials: "DA" },
	sam: { kind: "person", name: "Sam", initials: "SA" },
	gary: { kind: "person", name: "Gary Lum", initials: "GL", photo: "/people/gary-lum.jpg" },
	lorraine: {
		kind: "person",
		name: "Lorraine Delgado",
		initials: "LD",
		photo: "/people/lorraine-delgado.jpg",
	},
	tripPlanner: { kind: "bot", name: "Trip Planner", look: { color: "sky", face: "pill" } },
	budgetKeeper: { kind: "bot", name: "Budget Keeper", look: { color: "yellow", face: "square" } },
	inboxSorter: {
		kind: "bot",
		name: "Inbox Sorter",
		look: { color: "green", face: "pill", shape: "squircle" },
	},
	growthDesk: {
		kind: "bot",
		name: "Growth Desk",
		look: { color: "green", face: "pill", shape: "leaf" },
	},
	pricingAnalyst: {
		kind: "bot",
		name: "Pricing Analyst",
		look: { color: "sky", face: "pill", shape: "hexagon" },
	},
	copywriter: {
		kind: "bot",
		name: "Copywriter",
		look: { color: "orange", face: "pill", shape: "blob" },
	},
	researcher: {
		kind: "bot",
		name: "Researcher",
		look: { color: "sky", face: "pill", shape: "drop" },
	},
	journal: {
		kind: "bot",
		name: "Journal",
		look: { color: "purple", face: "pill", shape: "pebble" },
	},
	ticketDesk: {
		kind: "bot",
		name: "Ticket Desk",
		look: { color: "purple", face: "pill", shape: "circle" },
	},
} as const satisfies Record<string, ChatAuthor>;

export type CastName = keyof typeof cast;
