import type { AgentColor } from "@sugabots/contracts";
import type { CSSProperties } from "react";

/** A colour a bot can wear: the contracts' own list, named for what it colours here. */
export type BotColor = AgentColor;

/** A colour as each theme draws it. */
export interface ThemedColor {
	light: string;
	dark: string;
}

/**
 * How a bot's colour is drawn: the face and its eyes (the same in both themes),
 * and the tint behind anything the bot says, with the text and inline mono
 * that sit on that tint.
 */
export interface BotPalette {
	face: string;
	eyes: string;
	tint: ThemedColor;
	text: ThemedColor;
	mono: ThemedColor;
}

/**
 * The design's bot palette. Faces, eyes and tints are the design's values; the
 * text and mono tints it only gives for green, orange and purple, and the rest
 * are the same oklch recipe on each face's hue (dark text L .935 C .015, mono
 * L .87 C .08; light text L .275 C .065, mono L .5 C .14), all AA on their tint.
 */
export const botColors: Record<AgentColor, BotPalette> = {
	green: {
		face: "#22c55e",
		eyes: "#052e16",
		tint: { light: "#e3f5ea", dark: "#1a2621" },
		text: { light: "#10321d", dark: "#e6ece8" },
		mono: { light: "#166534", dark: "#bfe8d0" },
	},
	sky: {
		face: "#0ea5e9",
		eyes: "#082f49",
		tint: { light: "#e0f2fe", dark: "#15222b" },
		text: { light: "#002b41", dark: "#e1ebf2" },
		mono: { light: "#006b9a", dark: "#a7dcff" },
	},
	purple: {
		face: "#a855f7",
		eyes: "#2e1065",
		tint: { light: "#f3e8ff", dark: "#221a2b" },
		text: { light: "#2e1d42", dark: "#ebe6f2" },
		mono: { light: "#754ba3", dark: "#dfc8ff" },
	},
	ice: {
		face: "#38bdf8",
		eyes: "#0c4a6e",
		tint: { light: "#e0f2fe", dark: "#15232b" },
		text: { light: "#002c3f", dark: "#e0ecf2" },
		mono: { light: "#006c94", dark: "#a1deff" },
	},
	yellow: {
		face: "#eab308",
		eyes: "#422006",
		tint: { light: "#fef9c3", dark: "#27231a" },
		text: { light: "#342500", dark: "#eee9de" },
		mono: { light: "#7d5e00", dark: "#ecd197" },
	},
	orange: {
		face: "#f97316",
		eyes: "#431407",
		tint: { light: "#fdeee2", dark: "#2a1d14" },
		text: { light: "#431407", dark: "#f3e7de" },
		mono: { light: "#c2410c", dark: "#fdba74" },
	},
	rose: {
		face: "#f43f5e",
		eyes: "#4c0519",
		tint: { light: "#ffe4e6", dark: "#2a1519" },
		text: { light: "#42181c", dark: "#f3e6e6" },
		mono: { light: "#a33947", dark: "#ffc2c4" },
	},
	teal: {
		face: "#14b8a6",
		eyes: "#042f2e",
		tint: { light: "#ccfbf1", dark: "#15261f" },
		text: { light: "#002f2a", dark: "#dfedea" },
		mono: { light: "#007367", dark: "#97e6d9" },
	},
};

const themed = ({ light, dark }: ThemedColor) => `light-dark(${light}, ${dark})`;

/**
 * A bot's colours as CSS custom properties, for an element to set on itself
 * and its descendants to use: `--bot-face`, `--bot-eyes`, `--bot-tint`,
 * `--bot-text` and `--bot-mono`. The themed ones use `light-dark()`, so they
 * follow the element's `color-scheme`.
 */
export function botColorVariables(color: AgentColor): CSSProperties {
	const palette = botColors[color];
	return {
		"--bot-face": palette.face,
		"--bot-eyes": palette.eyes,
		"--bot-tint": themed(palette.tint),
		"--bot-text": themed(palette.text),
		"--bot-mono": themed(palette.mono),
	} as CSSProperties;
}
