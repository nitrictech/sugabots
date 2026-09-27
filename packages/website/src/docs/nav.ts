import type { BotLook } from "@sugabots/avatars";
import type { AccentTone } from "@/components/accent";

/** A page's place in the docs: its file in `content/`, and the bot that hosts it. */
export interface DocLink {
	slug: string;
	bot: BotLook;
}

export interface DocGroup {
	title: string;
	tone: AccentTone;
	/** What the group covers, said on the docs home. */
	summary: string;
	pages: readonly DocLink[];
}

/** The docs in reading order. A page in `content/` must be listed here to be published. */
export const docGroups: readonly DocGroup[] = [
	{
		title: "Start here",
		tone: "emerald",
		summary: "What Sugabots is, how to run it, and your first bot.",
		pages: [
			{ slug: "introduction", bot: { color: "green", face: "pill" } },
			{ slug: "quickstart", bot: { color: "sky", face: "dot" } },
			{ slug: "first-workspace", bot: { color: "purple", face: "wink" } },
		],
	},
	{
		title: "How it works",
		tone: "sky",
		summary: "The pieces of a workspace, and how people and bots use them together.",
		pages: [
			{ slug: "pods", bot: { color: "teal", face: "square" } },
			{ slug: "bots", bot: { color: "orange", face: "dot" } },
			{ slug: "conversations", bot: { color: "sky", face: "pill" } },
			{ slug: "tools-and-approvals", bot: { color: "yellow", face: "square" } },
			{ slug: "connections", bot: { color: "ice", face: "arc" } },
			{ slug: "models", bot: { color: "rose", face: "wink" } },
			{ slug: "web-search", bot: { color: "teal", face: "wink" } },
			{ slug: "routines", bot: { color: "yellow", face: "pill" } },
			{ slug: "people-and-roles", bot: { color: "green", face: "arc" } },
		],
	},
	{
		title: "Run it yourself",
		tone: "orange",
		summary: "Keep an installation up to date, or put it on a server.",
		pages: [
			{ slug: "run-and-update", bot: { color: "orange", face: "pill" } },
			{ slug: "deploy-with-docker", bot: { color: "ice", face: "dot" } },
		],
	},
	{
		title: "Reference",
		tone: "purple",
		summary: "Every setting, in one place.",
		pages: [{ slug: "configuration", bot: { color: "purple", face: "square" } }],
	},
];
