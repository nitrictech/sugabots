/**
 * Writes `Sugabots/Design/Palette.generated.swift` from the colour tokens the
 * web app declares on `:root` in `packages/web/src/app.css`, each as light and
 * dark draw it, so a token changed there changes here too. A token that isn't
 * a colour, such as a shadow, is left out.
 */
import { readFileSync } from "node:fs";
import type { GeneratedFiles } from "./generated-files.ts";

const stylesheet = new URL("../../../packages/web/src/app.css", import.meta.url);

/** A colour in sRGB, each channel from 0 to 1. */
export interface Rgba {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

type TokenValue = { kind: "colour"; light: Rgba; dark: Rgba } | { kind: "alias"; token: string };

interface Token {
	name: string;
	value: TokenValue;
	/** The comment written above it in the stylesheet, if any. */
	comment?: string;
}

/** The body of the first `:root { ... }` rule. */
function rootRule(css: string): string {
	const start = css.indexOf(":root {");
	const end = css.indexOf("\n}", start);
	if (start < 0 || end < 0) throw new Error("No :root rule in app.css");
	return css.slice(start + ":root {".length, end);
}

/** `a, b(c, d)` split at its top-level commas: `["a", "b(c, d)"]`. */
function topLevelArguments(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const character of text) {
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (character === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	parts.push(current.trim());
	return parts;
}

const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

/** `oklch(L C H)` in sRGB, clamped to its gamut. */
function oklchToRgb(lightness: number, chroma: number, hue: number): Rgba {
	const radians = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(radians);
	const b = chroma * Math.sin(radians);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const [red, green, blue] = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map((c) => clamp(fromLinear(c))) as [number, number, number];
	return { red, green, blue, alpha: 1 };
}

/** One CSS colour, or undefined if it's in a form this doesn't read. */
function colour(text: string): Rgba | undefined {
	const hex = /^#([0-9a-f]{6})$/i.exec(text)?.[1];
	if (hex) {
		const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
		return { red: channel(0), green: channel(2), blue: channel(4), alpha: 1 };
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(
		text,
	);
	if (rgb) {
		const [red, green, blue] = rgb.slice(1, 4).map((channel) => Number(channel) / 255) as [
			number,
			number,
			number,
		];
		return { red, green, blue, alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
	}
	const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(text);
	if (oklch) return oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
	return undefined;
}

/** A token's value, or undefined if it isn't a colour. */
function tokenValue(text: string): TokenValue | undefined {
	const alias = /^var\(--([\w-]+)\)$/.exec(text)?.[1];
	if (alias) return { kind: "alias", token: alias };
	const lightDark = /^light-dark\(([\s\S]*)\)$/.exec(text)?.[1];
	const [lightText, darkText] = lightDark ? topLevelArguments(lightDark) : [text, text];
	const light = colour(lightText ?? "");
	const dark = colour(darkText ?? "");
	return light && dark ? { kind: "colour", light, dark } : undefined;
}

/** The comment's text, without its `/*` and the `*` that starts each line. */
function commentText(comment: string): string {
	return comment
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, "").trim())
		.filter(Boolean)
		.join(" ");
}

/** Each colour token on `:root`, in the stylesheet's order. */
function tokens(css: string): Token[] {
	const found: Token[] = [];
	const known = new Set<string>();
	let comment: string | undefined;
	for (const match of rootRule(css).matchAll(/\/\*([\s\S]*?)\*\/|--([\w-]+):\s*([\s\S]*?);/g)) {
		if (match[1] !== undefined) {
			comment = commentText(match[1]);
			continue;
		}
		const [name, text] = [match[2] as string, (match[3] as string).replace(/\s+/g, " ").trim()];
		const value = tokenValue(text);
		if (value && (value.kind === "colour" || known.has(value.token))) {
			found.push({ name, value, comment });
			known.add(name);
		}
		comment = undefined;
	}
	return found;
}

/** Each colour token on `:root` by name, as light and dark draw it, with an alias resolved to the colour it names. */
export function colourTokens(): Map<string, { light: Rgba; dark: Rgba }> {
	const resolved = new Map<string, { light: Rgba; dark: Rgba }>();
	for (const { name, value } of tokens(readFileSync(stylesheet, "utf8"))) {
		const colour = value.kind === "colour" ? value : resolved.get(value.token);
		if (colour) resolved.set(name, { light: colour.light, dark: colour.dark });
	}
	return resolved;
}

/** `border-subtle` as a Swift name: `borderSubtle`. */
const swiftName = (token: string) =>
	token.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

const byte = (channel: number) =>
	Math.round(channel * 255)
		.toString(16)
		.padStart(2, "0")
		.toUpperCase();

/** A colour as a `UIColor`. */
function uiColor({ red, green, blue, alpha }: Rgba): string {
	const hex = JSON.stringify(`#${byte(red)}${byte(green)}${byte(blue)}`);
	return alpha === 1 ? `UIColor(hex: ${hex})` : `UIColor(hex: ${hex}, alpha: ${alpha})`;
}

function swiftValue(value: TokenValue): string {
	if (value.kind === "alias") return swiftName(value.token);
	const [light, dark] = [uiColor(value.light), uiColor(value.dark)];
	return light === dark ? `Color(${light})` : `themed(light: ${light}, dark: ${dark})`;
}

/** A comment as Swift doc comment lines, wrapped at about 100 columns. */
function docComment(text: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + word.length + 1 > 92) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(line);
	return lines.map((text) => `\t/// ${text}`);
}

export function generate(): GeneratedFiles {
	const declarations = tokens(readFileSync(stylesheet, "utf8")).flatMap((token) => [
		...(token.comment ? docComment(token.comment) : []),
		`\tstatic let ${swiftName(token.name)} = ${swiftValue(token.value)}`,
	]);
	const swift = [
		"// Generated by apps/ios/scripts/generate-palette.ts from packages/web/src/app.css. Do not edit.",
		"import SwiftUI",
		"import UIKit",
		"",
		"extension Palette {",
		...declarations,
		"}",
		"",
	].join("\n");
	return { files: new Map([["Sugabots/Design/Palette.generated.swift", swift]]) };
}
