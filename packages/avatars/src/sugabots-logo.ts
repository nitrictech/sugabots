import type { AgentColor } from "@sugabots/contracts";

/** The Sugabots mark: a tile of four bot-coloured dots, drawn to assets/sugabots-logo.svg. */
export const sugabotsLogo: {
	tint: AgentColor;
	bots: readonly [AgentColor, AgentColor, AgentColor, AgentColor];
} = {
	tint: "purple",
	bots: ["green", "ice", "rose", "orange"],
};
