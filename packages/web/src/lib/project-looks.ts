import type { ProjectColor } from "@sugabots/contracts";

/**
 * How each project colour is drawn: a tint for a small mark's background, and
 * the swatch a colour picker shows, which is also a full-size mark's fill. One
 * oklch recipe on each colour's hue: tint L .9 C .05 light and L .33 C .07
 * dark, swatch L .7 C .16 in both, as vivid as a bot's face.
 */
export const projectPalettes: Record<ProjectColor, { tile: string; swatch: string }> = {
	green: tint(148),
	blue: tint(255),
	plum: tint(340),
	amber: tint(78),
	teal: tint(192),
	purple: tint(298),
	rose: tint(18),
	orange: tint(50),
};

function tint(hue: number) {
	return {
		tile: `light-dark(oklch(0.9 0.05 ${hue}), oklch(0.33 0.07 ${hue}))`,
		swatch: `oklch(0.7 0.16 ${hue})`,
	};
}
