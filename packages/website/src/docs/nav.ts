import type { AvatarParts } from "@sugabots/avatars";
import type { AccentTone } from "@/components/accent";

/** A page's place in the docs: its file in `packages/docs/content/`, and the bot that hosts it. */
interface DocLink {
	slug: string;
	bot: AvatarParts;
}

export interface DocGroup {
	title: string;
	tone: AccentTone;
	/** What the group covers, said on the docs home. */
	summary: string;
	pages: readonly DocLink[];
}

/** The docs in reading order. A page in `packages/docs/content/` must be listed here to be published. */
export const docGroups: readonly DocGroup[] = [
	{
		title: "Start here",
		tone: "emerald",
		summary: "What Sugabots is, how to run it, and your first bot.",
		pages: [
			{ slug: "introduction", bot: { color: "green", eyes: "pill" } },
			{ slug: "quickstart", bot: { color: "sky", eyes: "dot" } },
			{ slug: "first-workspace", bot: { color: "purple", eyes: "wink" } },
		],
	},
	{
		title: "How it works",
		tone: "sky",
		summary: "The pieces of a workspace, and how members and bots use them together.",
		pages: [
			{ slug: "bots", bot: { color: "orange", eyes: "dot" } },
			{ slug: "projects", bot: { color: "teal", eyes: "square" } },
			{ slug: "chats", bot: { color: "sky", eyes: "pill" } },
			{ slug: "tools-and-approvals", bot: { color: "yellow", eyes: "square" } },
			{ slug: "connectors", bot: { color: "ice", eyes: "arc" } },
			{ slug: "models", bot: { color: "rose", eyes: "wink" } },
			{ slug: "usage", bot: { color: "amber", eyes: "square" } },
			{ slug: "web-search", bot: { color: "teal", eyes: "wink" } },
			{ slug: "automations", bot: { color: "yellow", eyes: "pill" } },
			{ slug: "members-and-roles", bot: { color: "green", eyes: "arc" } },
		],
	},
	{
		title: "Run it yourself",
		tone: "orange",
		summary: "Keep a server up to date, or host it for your team.",
		pages: [
			{ slug: "run-and-update", bot: { color: "orange", eyes: "pill" } },
			{ slug: "deploy-with-docker", bot: { color: "ice", eyes: "dot" } },
			{ slug: "upgrading-to-projects", bot: { color: "teal", eyes: "arc" } },
		],
	},
	{
		title: "Reference",
		tone: "purple",
		summary: "Every setting, in one place.",
		pages: [{ slug: "configuration", bot: { color: "purple", eyes: "square" } }],
	},
];
