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
			{/* One span per word, so satori wraps the headline between words like a browser. */}
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					columnGap: 26,
					fontSize: 100,
					fontWeight: 900,
					lineHeight: 1.08,
					letterSpacing: -2,
				}}
			>
				{`${siteMeta.headline}.`.split(" ").map((word) => (
					<span key={word}>{word}</span>
				))}
			</div>
			{/* A span per word here too, so satori doesn't break "self-hosted" at its hyphen. */}
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					columnGap: 9,
					fontSize: 34,
					color: hex(colors.zinc[400]),
				}}
			>
				{/* Keyed by where each word starts, since a word like "and" can come up twice. */}
				{[...siteMeta.description.matchAll(/\S+/g)].map((word) => (
					<span key={word.index}>{word[0]}</span>
				))}
			</div>
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
