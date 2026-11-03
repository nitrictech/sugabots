import type { Easing } from "motion/react";
import { viewboxPercentage } from "./face-marks.ts";
import type { Path } from "./layer-motion.ts";

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

/** The paths of one hop, `size` times as big as a full one, for the layers it moves. */
export function hopPaths(size: number): { rise: Path; squash: Path[]; eyesDrop: Path[] } {
	const scaled = (frames: number[], rest: number) =>
		frames.map((frame) => rest + (frame - rest) * size);
	const keyframes = (frames: number[][], ease: Easing[]): Path => ({
		kind: "keyframes",
		frames,
		times: HOP_TIMES,
		ease,
		seconds: HOP_SECONDS,
	});
	const widths = scaled(HOP.scaleX, 1);
	const heights = scaled(HOP.scaleY, 1);
	return {
		rise: keyframes(
			scaled(HOP.rise, 0).map((height) => [viewboxPercentage(height)]),
			RISE_AND_FALL,
		),
		squash: [
			keyframes(
				widths.map((width, index) => [width, heights[index] ?? 1]),
				SQUASHING,
			),
			{ kind: "spring", to: [1, 1], ...SETTLE },
		],
		eyesDrop: [
			keyframes(
				scaled(HOP.eyesDrop, 0).map((drop) => [viewboxPercentage(drop)]),
				SQUASHING,
			),
			{ kind: "spring", to: [0], ...SETTLE },
		],
	};
}
