import type { BotColor } from "./bot-colors.ts";

/** The Sugabots mark: a tile of four bot-coloured dots, drawn to assets/sugabots-logo.svg. */
export const sugabotsLogo: {
	tint: BotColor;
	bots: readonly [BotColor, BotColor, BotColor, BotColor];
} = {
	tint: "purple",
	bots: ["green", "cyan", "rose", "orange"],
};
