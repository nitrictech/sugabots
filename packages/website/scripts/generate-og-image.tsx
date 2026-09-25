/**
 * Writes public/og.png, the image link previews show for the site. Run with
 * `bun run --cwd packages/website generate:og` after changing the copy, the
 * logo or the crowd.
 *
 * satori lays out the JSX below into an SVG (it supports flexbox only) and
 * resvg rasterises it. Neither reads oklch, so Tailwind colours become hex.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { formatHex, parse, toGamut } from "culori";
import satori from "satori";
import colors from "tailwindcss/colors";
import { siteMeta } from "../src/site-meta.ts";

const WIDTH = 1200;
const HEIGHT = 630;

const HEADLINE = "Agents, now";
const HEADLINE_ACCENT = "multiplayer.";

const toSrgb = toGamut("rgb", "oklch");
function hex(tailwindColor: string): string {
	const parsed = parse(tailwindColor);
	if (!parsed) throw new Error(`Unparseable Tailwind colour: ${tailwindColor}`);
	return formatHex(toSrgb(parsed));
}

function readModule(specifier: string): Buffer {
	return readFileSync(fileURLToPath(import.meta.resolve(specifier)));
}

function svgDataUri(specifier: string): string {
	return `data:image/svg+xml;base64,${readModule(specifier).toString("base64")}`;
}

// The crowd SVG is 376×54; drawn a little larger beside the wordmark.
const CROWD_SCALE = 1.25;

const image = (
	<div
		style={{
			width: WIDTH,
			height: HEIGHT,
			display: "flex",
			flexDirection: "column",
			justifyContent: "space-between",
			padding: 80,
			backgroundColor: hex(colors.zinc[950]),
			color: hex(colors.zinc[100]),
			fontFamily: "Rubik",
		}}
	>
		<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
				<img
					src={svgDataUri("@sugabots/avatars/sugabots-logo.svg")}
					width={64}
					height={64}
					alt=""
				/>
				<span style={{ fontSize: 44, fontWeight: 900 }}>Sugabots</span>
			</div>
			<img
				src={svgDataUri("@sugabots/avatars/bot-crowd.svg")}
				width={376 * CROWD_SCALE}
				height={54 * CROWD_SCALE}
				alt=""
			/>
		</div>
		<div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					fontSize: 120,
					fontWeight: 900,
					lineHeight: 1,
					letterSpacing: -4,
				}}
			>
				<span>{HEADLINE}</span>
				<span style={{ color: hex(colors.emerald[400]) }}>{HEADLINE_ACCENT}</span>
			</div>
			<span style={{ fontSize: 34, color: hex(colors.zinc[400]) }}>{siteMeta.description}</span>
		</div>
	</div>
);

const svg = await satori(image, {
	width: WIDTH,
	height: HEIGHT,
	fonts: [
		{
			name: "Rubik",
			weight: 400,
			style: "normal",
			data: readModule("@fontsource/rubik/files/rubik-latin-400-normal.woff"),
		},
		{
			name: "Rubik",
			weight: 900,
			style: "normal",
			data: readModule("@fontsource/rubik/files/rubik-latin-900-normal.woff"),
		},
	],
});

const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
const outputPath = new URL(`../public${siteMeta.ogImagePath}`, import.meta.url);
writeFileSync(outputPath, png);
console.log(
	`Wrote ${outputPath.pathname} (${WIDTH}×${HEIGHT}, ${Math.round(png.length / 1024)} KB)`,
);
