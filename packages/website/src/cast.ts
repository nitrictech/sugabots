import type { ChatAuthor } from "@/components/chat";

/**
 * Everyone the landing page's and the docs' demo chats put words in
 * the mouth of. The portraits are from Unsplash; see the README.
 */
export const cast = {
	you: { kind: "member", name: "You", initials: "Y" },
	mum: { kind: "member", name: "Mum", initials: "MA" },
	dad: { kind: "member", name: "Dad", initials: "DA" },
	sam: { kind: "member", name: "Sam", initials: "SA" },
	gary: { kind: "member", name: "Gary Lum", initials: "GL", photo: "/members/gary-lum.jpg" },
	lorraine: {
		kind: "member",
		name: "Lorraine Delgado",
		initials: "LD",
		photo: "/members/lorraine-delgado.jpg",
	},
	tripPlanner: { kind: "bot", name: "Trip Planner", avatar: { color: "sky", eyes: "pill" } },
	budgetKeeper: { kind: "bot", name: "Budget Keeper", avatar: { color: "yellow", eyes: "square" } },
	inboxSorter: {
		kind: "bot",
		name: "Inbox Sorter",
		avatar: { color: "green", eyes: "pill", shape: "squircle" },
	},
	growthDesk: {
		kind: "bot",
		name: "Growth Desk",
		avatar: { color: "green", eyes: "pill", shape: "leaf" },
	},
	pricingAnalyst: {
		kind: "bot",
		name: "Pricing Analyst",
		avatar: { color: "sky", eyes: "pill", shape: "hexagon" },
	},
	copywriter: {
		kind: "bot",
		name: "Copywriter",
		avatar: { color: "orange", eyes: "pill", shape: "blob" },
	},
	researcher: {
		kind: "bot",
		name: "Researcher",
		avatar: { color: "sky", eyes: "pill", shape: "drop" },
	},
	journal: {
		kind: "bot",
		name: "Journal",
		avatar: { color: "purple", eyes: "pill", shape: "pebble" },
	},
	ticketDesk: {
		kind: "bot",
		name: "Ticket Desk",
		avatar: { color: "purple", eyes: "pill", shape: "circle" },
	},
} as const satisfies Record<string, ChatAuthor>;

export type CastName = keyof typeof cast;
