import type { AgentColor } from "@sugabots/contracts";
import { botColors } from "./bot-colors.ts";

const tint: AgentColor = "purple";
const bots: readonly [AgentColor, AgentColor, AgentColor, AgentColor] = [
	"green",
	"ice",
	"rose",
	"orange",
];

/* A 40-unit rounded tile with 6 units of padding and a 2-unit gap around a 2×2 grid of 13-unit dots. */
export const LOGO_SIZE = 40;
const TILE_RADIUS = 14;
const PADDING = 6;
const GAP = 2;
const DOT_SIZE = (LOGO_SIZE - PADDING * 2 - GAP) / 2;

function dotCentre(cell: number): number {
	return PADDING + cell * (DOT_SIZE + GAP) + DOT_SIZE / 2;
}

/**
 * The Sugabots mark, a tile of four bot-coloured dots, as shapes in a
 * `LOGO_SIZE` square. `SugabotsMark` draws it, and so does
 * assets/sugabots-logo.svg.
 */
export const sugabotsLogo = {
	tile: {
		radius: TILE_RADIUS,
		// The tint's eye colour: solid and dark, so the dots stand out on light and dark backgrounds.
		fill: botColors[tint].eyes,
	},
	dots: bots.map((color, index) => ({
		cx: dotCentre(index % 2),
		cy: dotCentre(Math.floor(index / 2)),
		r: DOT_SIZE / 2,
		fill: botColors[color].face,
	})),
};
