/**
 * The colours a bot can wear: its face, its eyes, a swatch of the face colour,
 * and a tint for what it says or owns.
 *
 * Keys are Tailwind hue names. Class names must use BOT_FACE_SHADE and
 * BOT_EYES_SHADE, which scripts/generate-assets.ts reads from Tailwind's
 * palette, and are written out in full so Tailwind can find them.
 */
export const BOT_FACE_SHADE = 500;
export const BOT_EYES_SHADE = 950;

export const botColors = {
	rose: {
		faceFill: "fill-rose-500",
		eyesFill: "fill-rose-950",
		eyesStroke: "stroke-rose-950",
		swatch: "bg-rose-500",
		tint: "bg-rose-100 text-rose-950 dark:bg-rose-950/50 dark:text-rose-50",
	},
	orange: {
		faceFill: "fill-orange-500",
		eyesFill: "fill-orange-950",
		eyesStroke: "stroke-orange-950",
		swatch: "bg-orange-500",
		tint: "bg-orange-100 text-orange-950 dark:bg-orange-950/50 dark:text-orange-50",
	},
	yellow: {
		faceFill: "fill-yellow-500",
		eyesFill: "fill-yellow-950",
		eyesStroke: "stroke-yellow-950",
		swatch: "bg-yellow-500",
		tint: "bg-yellow-100 text-yellow-950 dark:bg-yellow-950/50 dark:text-yellow-50",
	},
	green: {
		faceFill: "fill-green-500",
		eyesFill: "fill-green-950",
		eyesStroke: "stroke-green-950",
		swatch: "bg-green-500",
		tint: "bg-green-100 text-green-950 dark:bg-green-950/50 dark:text-green-50",
	},
	teal: {
		faceFill: "fill-teal-500",
		eyesFill: "fill-teal-950",
		eyesStroke: "stroke-teal-950",
		swatch: "bg-teal-500",
		tint: "bg-teal-100 text-teal-950 dark:bg-teal-950/50 dark:text-teal-50",
	},
	cyan: {
		faceFill: "fill-cyan-500",
		eyesFill: "fill-cyan-950",
		eyesStroke: "stroke-cyan-950",
		swatch: "bg-cyan-500",
		tint: "bg-cyan-100 text-cyan-950 dark:bg-cyan-950/50 dark:text-cyan-50",
	},
	sky: {
		faceFill: "fill-sky-500",
		eyesFill: "fill-sky-950",
		eyesStroke: "stroke-sky-950",
		swatch: "bg-sky-500",
		tint: "bg-sky-100 text-sky-950 dark:bg-sky-950/50 dark:text-sky-50",
	},
	purple: {
		faceFill: "fill-purple-500",
		eyesFill: "fill-purple-950",
		eyesStroke: "stroke-purple-950",
		swatch: "bg-purple-500",
		tint: "bg-purple-100 text-purple-950 dark:bg-purple-950/50 dark:text-purple-50",
	},
} as const;

export type BotColor = keyof typeof botColors;
