import type { Easing } from "motion/react";
import { viewboxPercentage } from "./face-marks.ts";
import { type KeyframesPath, layerKinds, type Path, type Values } from "./layer-motion.ts";

/*
 * One hop, as keyframes at these moments (seconds): crouch, take off, top,
 * touch down, land. It squashes before it jumps and as it lands, and stretches
 * as it moves fast; each squash is matched by a widening, so it keeps its
 * size. The eyes trail the head: they sink as it springs up, float on as it
 * stops at the top, and drop as it lands. Heights are in viewbox units.
 */
export const HOP_SECONDS = 0.56;
const HOP_TIMES = [0, 0.08, 0.2, 0.32, 0.5, 0.56].map((moment) => moment / HOP_SECONDS);
const HOP = {
	rise: [0, 0, -4.5, -7, 0, 0],
	scaleY: [1, 0.88, 1.1, 1, 1.06, 0.88],
	scaleX: [1, 1.1, 0.92, 1, 0.95, 1.1],
	eyesDrop: [0, 0.8, 1.2, -0.8, -0.6, 1.5],
};
/** Up from the crouch fast, slowing to the top; down again faster and faster. */
const RISE_AND_FALL: Easing[] = ["linear", "linear", "easeOut", "easeIn", "linear"];
const SQUASHING: Easing[] = HOP_TIMES.slice(1).map(() => "easeInOut");
/** How the bot springs back to rest after landing: a quick wobble. */
const SETTLE = { stiffness: 500, damping: 12 };

/** The layers a hop moves. */
type HopLayer = "hopRise" | "hopSquash" | "hopEyesDrop";

const hopKeyframes = (frames: Values[], ease: Easing[]): KeyframesPath => ({
	kind: "keyframes",
	frames,
	times: HOP_TIMES,
	ease,
	seconds: HOP_SECONDS,
});

const settleTo = (layer: HopLayer): Path => ({
	kind: "spring",
	to: layerKinds[layer].rest,
	...SETTLE,
});

/** A full hop: the paths each layer it moves plays, one after another. */
export const FULL_HOP: Readonly<Record<HopLayer, readonly Path[]>> = {
	hopRise: [
		hopKeyframes(
			HOP.rise.map((height) => [viewboxPercentage(height)]),
			RISE_AND_FALL,
		),
	],
	hopSquash: [
		hopKeyframes(
			HOP.scaleX.map((width, index) => [width, HOP.scaleY[index] ?? 1]),
			SQUASHING,
		),
		settleTo("hopSquash"),
	],
	hopEyesDrop: [
		hopKeyframes(
			HOP.eyesDrop.map((drop) => [viewboxPercentage(drop)]),
			SQUASHING,
		),
		settleTo("hopEyesDrop"),
	],
};

/**
 * The paths of one hop, `size` times as big as `FULL_HOP`, for the layers it
 * moves: each value's distance from where its layer rests is scaled by `size`.
 */
export function hopPaths(size: number): Record<HopLayer, readonly Path[]> {
	const scaled = (layer: HopLayer) => {
		const rest = layerKinds[layer].rest;
		const about = (values: Values) =>
			values.map((value, index) => {
				const resting = rest[index] ?? 0;
				return resting + (value - resting) * size;
			});
		return FULL_HOP[layer].map(
			(path): Path =>
				path.kind === "spring"
					? { ...path, to: about(path.to) }
					: { ...path, frames: path.frames.map(about) },
		);
	};
	return {
		hopRise: scaled("hopRise"),
		hopSquash: scaled("hopSquash"),
		hopEyesDrop: scaled("hopEyesDrop"),
	};
}
