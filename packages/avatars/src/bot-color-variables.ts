import type { BotColor } from "@sugabots/contracts";
import type { CSSProperties } from "react";
import { botPalettes, type ThemedColor } from "./bot-colors.ts";

const themed = ({ light, dark }: ThemedColor) => `light-dark(${light}, ${dark})`;

/**
 * A bot's colours as CSS custom properties, for an element to set on itself
 * and its descendants to use: `--bot-face`, `--bot-eyes`, `--bot-tint`,
 * `--bot-text` and `--bot-mono`. The themed ones use `light-dark()`, so they
 * follow the element's `color-scheme`.
 */
export function botColorVariables(color: BotColor): CSSProperties {
	const palette = botPalettes[color];
	return {
		"--bot-face": palette.face,
		"--bot-eyes": palette.eyes,
		"--bot-tint": themed(palette.tint),
		"--bot-text": themed(palette.text),
		"--bot-mono": themed(palette.mono),
	} as CSSProperties;
}
