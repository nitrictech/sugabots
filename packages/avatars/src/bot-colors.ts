import type { AgentColor } from "@sugabots/contracts";

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
 * The design's bot palette. Faces, eyes and tints are the design's values,
 * except red, amber, lime, emerald, indigo, violet, fuchsia and pink, which
 * take Tailwind's 500, 950 and 100 with a dark tint of L .245 C .028 on the
 * face's hue. The design gives text and mono tints only for green, orange and
 * purple, and the rest are the same oklch recipe on each face's hue (dark text
 * L .935 C .015, mono L .87 C .08; light text L .275 C .065, mono L .5 C .14),
 * all AA on their tint.
 */
export const botColors: Record<AgentColor, BotPalette> = {
	red: {
		face: "#ef4444",
		eyes: "#450a0a",
		tint: { light: "#fee2e2", dark: "#2d1b1a" },
		text: { light: "#421917", dark: "#f3e6e4" },
		mono: { light: "#a43b38", dark: "#ffc3bd" },
	},
	orange: {
		face: "#f97316",
		eyes: "#431407",
		tint: { light: "#fdeee2", dark: "#2a1d14" },
		text: { light: "#431407", dark: "#f3e7de" },
		mono: { light: "#c2410c", dark: "#fdba74" },
	},
	amber: {
		face: "#f59e0b",
		eyes: "#451a03",
		tint: { light: "#fef3c7", dark: "#291e11" },
		text: { light: "#3a2100", dark: "#f0e8df" },
		mono: { light: "#8a5600", dark: "#f7cc9b" },
	},
	yellow: {
		face: "#eab308",
		eyes: "#422006",
		tint: { light: "#fef9c3", dark: "#27231a" },
		text: { light: "#342500", dark: "#eee9de" },
		mono: { light: "#7d5e00", dark: "#ecd197" },
	},
	lime: {
		face: "#84cc16",
		eyes: "#1a2e05",
		tint: { light: "#ecfccb", dark: "#1c2315" },
		text: { light: "#1c2e07", dark: "#e6ece1" },
		mono: { light: "#477200", dark: "#c2e0a9" },
	},
	green: {
		face: "#22c55e",
		eyes: "#052e16",
		tint: { light: "#e3f5ea", dark: "#1a2621" },
		text: { light: "#10321d", dark: "#e6ece8" },
		mono: { light: "#166534", dark: "#bfe8d0" },
	},
	emerald: {
		face: "#10b981",
		eyes: "#022c22",
		tint: { light: "#d1fae5", dark: "#14251c" },
		text: { light: "#00301f", dark: "#e1ede6" },
		mono: { light: "#007650", dark: "#a4e5c5" },
	},
	teal: {
		face: "#14b8a6",
		eyes: "#042f2e",
		tint: { light: "#ccfbf1", dark: "#15261f" },
		text: { light: "#002f2a", dark: "#dfedea" },
		mono: { light: "#007367", dark: "#97e6d9" },
	},
	sky: {
		face: "#0ea5e9",
		eyes: "#082f49",
		tint: { light: "#e0f2fe", dark: "#15222b" },
		text: { light: "#002b41", dark: "#e1ebf2" },
		mono: { light: "#006b9a", dark: "#a7dcff" },
	},
	ice: {
		face: "#38bdf8",
		eyes: "#0c4a6e",
		tint: { light: "#e0f2fe", dark: "#15232b" },
		text: { light: "#002c3f", dark: "#e0ecf2" },
		mono: { light: "#006c94", dark: "#a1deff" },
	},
	indigo: {
		face: "#6366f1",
		eyes: "#1e1b4b",
		tint: { light: "#e0e7ff", dark: "#1d1f2e" },
		text: { light: "#202347", dark: "#e7e9f4" },
		mono: { light: "#5157b1", dark: "#c9d1ff" },
	},
	violet: {
		face: "#8b5cf6",
		eyes: "#2e1065",
		tint: { light: "#ede9fe", dark: "#211e2d" },
		text: { light: "#292044", dark: "#e9e8f3" },
		mono: { light: "#6850ab", dark: "#d5ccff" },
	},
	purple: {
		face: "#a855f7",
		eyes: "#2e1065",
		tint: { light: "#f3e8ff", dark: "#221a2b" },
		text: { light: "#2e1d42", dark: "#ebe6f2" },
		mono: { light: "#754ba3", dark: "#dfc8ff" },
	},
	fuchsia: {
		face: "#d946ef",
		eyes: "#4a044e",
		tint: { light: "#fae8ff", dark: "#271c28" },
		text: { light: "#361c3a", dark: "#eee6f0" },
		mono: { light: "#874392", dark: "#eec3f4" },
	},
	pink: {
		face: "#ec4899",
		eyes: "#500724",
		tint: { light: "#fce7f3", dark: "#2b1b21" },
		text: { light: "#3f182a", dark: "#f2e6ea" },
		mono: { light: "#9d3a68", dark: "#ffbfd7" },
	},
	rose: {
		face: "#f43f5e",
		eyes: "#4c0519",
		tint: { light: "#ffe4e6", dark: "#2a1519" },
		text: { light: "#42181c", dark: "#f3e6e6" },
		mono: { light: "#a33947", dark: "#ffc2c4" },
	},
};
