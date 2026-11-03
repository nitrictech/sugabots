import {
	calcGeneratorDuration,
	type Easing,
	easingDefinitionToFunction,
	interpolate,
	spring,
} from "motion/react";
import type { RefObject } from "react";
import { FACE_VIEWBOX_SIZE, THINKING_DOT_RADIUS } from "./face-marks.ts";

/*
 * How the face's layers are animated so they cost as little as a GIF.
 *
 * A browser animation that changes smoothly makes the browser draw, and the
 * system redraw its window, at the display's full rate (often 120 times a
 * second) for as long as it runs, however small the face. These animations
 * instead change on the ticks of one clock shared by every layer of every
 * face, 30 a second as a video's frames, and only on the ticks where what's
 * drawn has moved by half a device pixel; the browser holds each change until
 * the next. So however many faces move, the page is redrawn at most 30 times a
 * second, and on a small face a glance is a handful of frames.
 */

type Values = readonly number[];

/** What a layer's values draw: its transform, and for some its opacity. */
interface LayerStyle {
	transform: string;
	opacity?: number;
}

/** One kind of layer: its transform as numbers, how it's drawn, and how far one unit moves what's drawn. */
interface LayerKind {
	rest: Values;
	draw: (values: Values) => LayerStyle;
	/** Device pixels moved by one unit of each value, on a face `facePixels` device pixels wide. */
	pixelsPerUnit: (facePixels: number) => Values;
}

const pixelsPerPercent = (facePixels: number) => facePixels / 100;
/** Turning moves the top of the face most: a face's width (it's square) from the pivot at its bottom. */
const pixelsPerDegree = (facePixels: number) => (facePixels * Math.PI) / 180;
/** Opacity counts as this many pixels per unit, so with half-pixel steps it changes in steps of 1/64. */
const OPACITY_PIXELS_PER_UNIT = 32;
/** A thinking dot's height against the face's width: its rise is a share of its own height. */
const DOT_SHARE_OF_FACE = (THINKING_DOT_RADIUS * 2) / FACE_VIEWBOX_SIZE;

const translateY: LayerKind = {
	rest: [0],
	draw: ([y = 0]) => ({ transform: `translateY(${y}%)` }),
	pixelsPerUnit: (px) => [pixelsPerPercent(px)],
};
const translateX: LayerKind = {
	rest: [0],
	draw: ([x = 0]) => ({ transform: `translateX(${x}%)` }),
	pixelsPerUnit: (px) => [pixelsPerPercent(px)],
};
const translateXY: LayerKind = {
	rest: [0, 0],
	draw: ([x = 0, y = 0]) => ({ transform: `translate(${x}%, ${y}%)` }),
	pixelsPerUnit: (px) => [pixelsPerPercent(px), pixelsPerPercent(px)],
};
const rotate: LayerKind = {
	rest: [0],
	draw: ([degrees = 0]) => ({ transform: `rotate(${degrees}deg)` }),
	pixelsPerUnit: (px) => [pixelsPerDegree(px)],
};

/** The face's layers, each holding one kind of motion; translations are percentages of the face. */
export const layerKinds = {
	hopRise: translateY,
	hopSquash: {
		rest: [1, 1],
		draw: ([width = 1, height = 1]) => ({ transform: `scale(${width}, ${height})` }),
		pixelsPerUnit: (px) => [px, px],
	},
	gazeMove: translateXY,
	moodMove: translateY,
	wiggleMove: translateX,
	gazeTilt: rotate,
	moodTilt: rotate,
	wiggleTilt: rotate,
	hopEyesDrop: translateY,
	eyesLift: translateY,
	eyesGaze: {
		rest: [0, 0, 1],
		draw: ([x = 0, y = 0, width = 1]) => ({
			transform: `translate(${x}%, ${y}%) scaleX(${width})`,
		}),
		pixelsPerUnit: (px) => [pixelsPerPercent(px), pixelsPerPercent(px), px],
	},
	/** A thinking dot: how far it has risen, as a share of its own height, and how bright it is. */
	dot: {
		rest: [0, 0.45],
		draw: ([rise = 0, opacity = 1]) => ({ transform: `translateY(${-rise * 100}%)`, opacity }),
		pixelsPerUnit: (px) => [px * DOT_SHARE_OF_FACE, OPACITY_PIXELS_PER_UNIT],
	},
} satisfies Record<string, LayerKind>;

export type LayerName = keyof typeof layerKinds;

/** How a layer looks at rest, for its first render. */
export function restingStyle(name: LayerName): LayerStyle {
	return layerKinds[name].draw(layerKinds[name].rest);
}

/** A way of getting from one set of values to another, over time. */
export type Path =
	/** Springs to `to`, as motion's springs do. */
	| { kind: "spring"; to: Values; stiffness: number; damping: number }
	/**
	 * Passes through `frames` at `times` (shares of `seconds`, from 0 to 1),
	 * eased between each pair by `ease`; the first frame is ignored and replaced
	 * by wherever the layer is.
	 */
	| { kind: "keyframes"; frames: Values[]; times: number[]; ease: Easing[]; seconds: number };

/** Half a device pixel: no finer move could show. */
const STEP_PIXELS = 0.5;
/** The shared clock's ticks, which every change falls on: a video's frame rate. */
export const TICK_SECONDS = 1 / 30;
/** How finely a spring is stepped through to find when it settles. */
export const SPRING_SETTLE_STEP_MILLISECONDS = 1000 / 120;
/** A spring is cut off by this long at the latest, wherever it has got to. */
export const LONGEST_SPRING_MILLISECONDS = 3000;
/** How far ahead a layer's path is looked at to tell how fast it's moving. */
export const VELOCITY_SECONDS = 1 / 240;
/** How long a repeating path takes to ease to where it starts, from wherever the layer is. */
export const LEAD_IN_SECONDS = 0.25;

interface Playing {
	animation: Animation;
	/** Where the path has reached, `seconds` into it. */
	valuesAt: (seconds: number) => Values;
	seconds: number;
	repeats: boolean;
	startedAt: number;
}

/** Animates one layer of a face along paths, stepping only where it visibly moves (see the top of this file). */
export class LayerMotion {
	private values: Values;
	private playing: Playing | undefined;
	private readonly layer: RefObject<HTMLElement | null>;
	private readonly kind: LayerKind;
	/** The face's width in device pixels, read when a path starts. */
	private readonly facePixels: () => number;

	// Fields set by hand rather than as parameter properties, so Node can load this file as it is, as the iOS app's generator does.
	constructor(layer: RefObject<HTMLElement | null>, kind: LayerKind, facePixels: () => number) {
		this.layer = layer;
		this.kind = kind;
		this.facePixels = facePixels;
		this.values = kind.rest;
	}

	/** Where the layer rests. */
	get rest(): Values {
		return this.kind.rest;
	}

	/** Where the layer is now, partway along whatever it's playing. */
	now(): Values {
		const { playing } = this;
		if (!playing) return this.values;
		return playing.valuesAt(this.elapsed(playing));
	}

	/** How fast each value is changing now, per second, so a new spring can carry on at the same speed. */
	private velocity(): Values {
		const { playing } = this;
		if (!playing) return this.values.map(() => 0);
		const elapsed = this.elapsed(playing);
		const before = playing.valuesAt(elapsed);
		const after = playing.valuesAt(Math.min(elapsed + VELOCITY_SECONDS, playing.seconds));
		return before.map((value, index) => ((after[index] ?? value) - value) / VELOCITY_SECONDS);
	}

	private elapsed(playing: Playing): number {
		let elapsed = Math.max(0, (timelineNow() - playing.startedAt) / 1000);
		if (playing.repeats) elapsed %= playing.seconds;
		return Math.min(elapsed, playing.seconds);
	}

	/** Sets the layer straight to `values`, with no animation. */
	jump(values: Values): void {
		this.stop();
		this.values = values;
		const element = this.layer.current;
		if (element) Object.assign(element.style, this.kind.draw(values));
	}

	/**
	 * Plays `paths` one after another, as one animation, from wherever the layer
	 * is and at the speed it's moving: again and again if `repeat`, after
	 * `delaySeconds`. A repeating path first eases to where it starts, so each
	 * time round begins from the same place.
	 */
	play(paths: Path | Path[], { repeat = false, delaySeconds = 0 } = {}): void {
		const element = this.layer.current;
		// Nothing to show it on, so nothing should be left playing.
		if (!element) {
			this.stop();
			return;
		}
		const list = Array.isArray(paths) ? paths : [paths];
		const from = this.now();
		const loopStart = repeat ? firstFrame(list[0]) : undefined;
		if (loopStart && this.visiblyApart(from, loopStart)) {
			const leadIn: Path = {
				kind: "keyframes",
				frames: [from, loopStart],
				times: [0, 1],
				ease: ["easeInOut"],
				seconds: LEAD_IN_SECONDS,
			};
			this.start(element, sequence(from, [leadIn]), {
				afterwards: () => this.play(paths, { repeat, delaySeconds }),
			});
			return;
		}
		this.start(element, sequence(from, list, this.velocity()), { repeat, delaySeconds });
	}

	/** Stops where it is, holding that pose. */
	stop(): void {
		const { playing } = this;
		if (!playing) return;
		this.values = this.now();
		this.playing = undefined;
		playing.animation.onfinish = null;
		playing.animation.cancel();
		const element = this.layer.current;
		if (element) Object.assign(element.style, this.kind.draw(this.values));
	}

	/** Runs `path` on the layer as a stepped animation on the shared clock, then runs `afterwards`. */
	private start(
		element: HTMLElement,
		path: { valuesAt: (seconds: number) => Values; seconds: number },
		{
			repeat = false,
			delaySeconds = 0,
			afterwards,
		}: { repeat?: boolean; delaySeconds?: number; afterwards?: () => void },
	): void {
		// A whole number of ticks long, so a repeating path stays on the clock.
		const ticks = Math.max(1, Math.ceil(path.seconds / TICK_SECONDS - 1e-6));
		const seconds = ticks * TICK_SECONDS;
		const valuesAt = (t: number) => path.valuesAt(Math.min(t, path.seconds));
		const keyframes = this.stepped(valuesAt, ticks);
		// A path that moves nothing visibly, such as a spring to where the layer already is, needs no animation.
		if (
			!repeat &&
			keyframes.every(
				(keyframe) =>
					keyframe.transform === keyframes[0]?.transform &&
					keyframe.opacity === keyframes[0]?.opacity,
			)
		) {
			this.jump(valuesAt(seconds));
			afterwards?.();
			return;
		}
		this.stop();
		const animation = element.animate(keyframes, {
			duration: seconds * 1000,
			iterations: repeat ? Number.POSITIVE_INFINITY : 1,
			fill: "both",
		});
		// Started on a tick of the shared clock, as soon as the delay allows.
		const tickMilliseconds = TICK_SECONDS * 1000;
		const startedAt =
			Math.ceil((timelineNow() + delaySeconds * 1000) / tickMilliseconds) * tickMilliseconds;
		animation.startTime = startedAt;
		const playing: Playing = { animation, valuesAt, seconds, repeats: repeat, startedAt };
		this.playing = playing;
		animation.onfinish = () => {
			if (this.playing !== playing) return;
			// Kept as the layer's own style, so no finished animation lingers.
			this.jump(valuesAt(seconds));
			afterwards?.();
		};
	}

	/** Whether two poses would be drawn visibly apart. */
	private visiblyApart(a: Values, b: Values): boolean {
		const pixelsPerUnit = this.kind.pixelsPerUnit(this.facePixels());
		return a.some(
			(value, index) =>
				Math.abs(value - (b[index] ?? value)) * (pixelsPerUnit[index] ?? 1) >= STEP_PIXELS,
		);
	}

	/**
	 * Keyframes along a path `ticks` of the shared clock long: one on each tick
	 * where what's drawn has moved by half a device pixel, held until the next.
	 */
	private stepped(valuesAt: (seconds: number) => Values, ticks: number): Keyframe[] {
		const pixelsPerUnit = this.kind.pixelsPerUnit(this.facePixels());
		const keyframe = (values: Values, offset: number): Keyframe => ({
			...this.kind.draw(values),
			offset,
			easing: "step-end",
		});
		let shown = valuesAt(0);
		const keyframes = [keyframe(shown, 0)];
		for (let tick = 1; tick < ticks; tick++) {
			const values = valuesAt(tick * TICK_SECONDS);
			const moved = values.some(
				(value, index) =>
					Math.abs(value - (shown[index] ?? value)) * (pixelsPerUnit[index] ?? 1) >= STEP_PIXELS,
			);
			if (!moved) continue;
			shown = values;
			keyframes.push(keyframe(values, tick / ticks));
		}
		keyframes.push(keyframe(valuesAt(ticks * TICK_SECONDS), 1));
		return keyframes;
	}
}

/**
 * Paths one after another, each from where the last ends, as one function of
 * time; the first starts at `velocity`, where it's a spring.
 */
function sequence(
	from: Values,
	paths: Path[],
	velocity?: Values,
): { valuesAt: (seconds: number) => Values; seconds: number } {
	const parts: { valuesAt: (seconds: number) => Values; seconds: number; startsAt: number }[] = [];
	let start = from;
	let total = 0;
	for (const [index, path] of paths.entries()) {
		const part = pathFrom(start, path, index === 0 ? velocity : undefined);
		parts.push({ ...part, startsAt: total });
		total += part.seconds;
		start = part.valuesAt(part.seconds);
	}
	const valuesAt = (t: number) => {
		const part = parts.findLast((one) => t >= one.startsAt) ?? parts[0];
		return part ? part.valuesAt(Math.min(t - part.startsAt, part.seconds)) : from;
	};
	return { valuesAt, seconds: total };
}

/** The time on the document's animation timeline, which the browser's animations run by, in milliseconds. */
function timelineNow(): number {
	const time = document.timeline.currentTime;
	return typeof time === "number" ? time : performance.now();
}

/** Where a path starts, if it says. */
function firstFrame(path: Path | undefined): Values | undefined {
	return path?.kind === "keyframes" ? path.frames[0] : undefined;
}

/** A path from `from` (moving at `velocity`, for a spring) as a function of time, and how long it takes. */
function pathFrom(
	from: Values,
	path: Path,
	velocity?: Values,
): { valuesAt: (seconds: number) => Values; seconds: number } {
	if (path.kind === "spring") {
		// One spring for each value, so each carries on at the speed it was moving.
		const springs = from.map((value, index) =>
			spring({
				keyframes: [value, path.to[index] ?? value],
				velocity: velocity?.[index] ?? 0,
				stiffness: path.stiffness,
				damping: path.damping,
			}),
		);
		const settlesIn = Math.max(
			0,
			...springs.map((one) =>
				calcGeneratorDuration(one, SPRING_SETTLE_STEP_MILLISECONDS, LONGEST_SPRING_MILLISECONDS),
			),
		);
		const seconds = Math.min(settlesIn, LONGEST_SPRING_MILLISECONDS) / 1000;
		const valuesAt = (t: number) =>
			springs.map((one, index) =>
				t >= seconds ? (path.to[index] ?? 0) : one.next(Math.max(0, t) * 1000).value,
			);
		return { valuesAt, seconds };
	}
	const between = interpolate(
		path.times.map((time) => time * path.seconds),
		[from, ...path.frames.slice(1)].map((frame) => [...frame]),
		{ ease: path.ease.map((ease) => easingDefinitionToFunction(ease)) },
	);
	// Copied, as the interpolation hands back the same array each time.
	return { valuesAt: (t) => [...between(t)], seconds: path.seconds };
}
