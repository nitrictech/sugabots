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
];
