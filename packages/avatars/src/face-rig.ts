import {
	animate,
	type Easing,
	type MotionValue,
	motionValue,
	useSpring,
	useTransform,
} from "motion/react";
import { createRef, type RefObject, useEffect, useRef, useState } from "react";
import { THINKING_DOT_RADIUS, viewboxPercentage } from "./face-marks.ts";
import { HOP_SECONDS, hopPaths } from "./hop.ts";
import { LayerMotion, type LayerName, layerKinds } from "./layer-motion.ts";

/*
 * Why the face is built from HTML layers: Chrome can't hand a transform on an
 * element inside an SVG to the GPU, so animating one makes it restyle and
 * repaint the page every frame. It can for HTML elements, so the face's moves
 * (glances, hops, a wiggle, the thinking dots, a mood's pose) are animated by
 * the browser on layers of their own, in steps only as fine as can show (see
 * layer-motion.ts); between moves nothing runs at all. Any animation driven
 * from script makes the browser update the whole page each frame it runs, so
 * only the eyes' own shapes (blinking, fluttering, smiling, flattening and
 * shrinking away) and the thinking dots' growing are still drawn that way,
 * and briefly.
 */

/**
 * How a mood holds the face, eased into whenever the mood changes. Distances
 * are in the face's 40-unit viewbox.
 */
export interface MoodLook {
	/** How open the eyes are, 1 being wide open. */
	eyesOpen: number;
	/** How far each open eye has become a smiling arc, 0 not at all. */
	smile: number;
	/** How far an arc eye has flattened into a shut lid, so it matches open eyes nearly shut. */
	arcsFlat: number;
	/** How far the eyes have given way to three thinking dots, 0 not at all. */
	dots: number;
	/** How far the eyes sit above (negative) or below their place, as cheeks push them up or the face sags. */
	eyesLift: number;
	/** How far the head sinks, and leans in degrees, on top of where it looks. */
	headDrop: number;
	headLean: number;
}

/** What moods and actions move the face with. */
export interface FaceControls {
	/** Turns the eyes, and after them the head, to a point from -1 to 1 on each axis; returns how far they turned. */
	lookAt(x: number, y: number): number;
	/** Notes that the eyes are on the pointer or typing, which idle glances then leave alone a while. */
	markWatched(): void;
	isWatching(): boolean;
	blink(twice?: boolean): void;
	/** A hop `size` times as big as a full one; a new hop takes over from one in the air. */
	hop(size?: number): void;
	isAirborne(): boolean;
	/** Wiggles the head from side to side until the returned function eases it still. */
	wiggle(): () => void;
	/** Raises the thinking dots in turn until the returned function settles them. */
	riseDots(): () => void;
	/** Opens the eyes half way for a moment, as a sleepy bot's do, however shut its mood holds them. */
	flutter(): void;
}

type LayerRef = RefObject<HTMLSpanElement | null>;
type HeadLayerName = Exclude<LayerName, "dot">;

const headLayerNames = Object.keys(layerKinds).filter(
	(name): name is HeadLayerName => name !== "dot",
);

/** The face's HTML layers, which the browser animates. */
export type FaceLayers = Record<HeadLayerName, LayerRef> & {
	/** The thinking dots, left to right. */
	dots: readonly [LayerRef, LayerRef, LayerRef];
};

/** The values the eyes' shapes are drawn with, and the layers the browser animates. */
export interface FaceDrawing {
	layers: FaceLayers;
	/** How tall an open eye is drawn, before the shut-eye minimum. */
	eyeHeight: MotionValue<number>;
	eyesShrink: MotionValue<number>;
	smile: MotionValue<number>;
	arcsFlat: MotionValue<number>;
	outerDotsGrow: MotionValue<number>;
	middleDotGrows: MotionValue<number>;
}

/*
 * The eyes travel further than the head moves; that difference is what reads
 * as depth.
 */
/** How far the eyes slide sideways, and up or down, looking all the way. */
const EYE_TRAVEL_X = 5;
const EYE_TRAVEL_Y = 3;
/** How far the eyes dip as they near the side, so they follow the head's curve rather than a straight line. */
const EYE_EDGE_DIP = 0.8;
/** How much narrower the eyes get looking all the way to one side, as if turned away on a ball. */
const EYE_FORESHORTENING = 0.18;
const HEAD_TRAVEL_X = 1.2;
const HEAD_TRAVEL_Y = 0.6;
const HEAD_TILT_DEGREES = 4;

/** Eyes jump to what they look at almost at once; they never drift. */
const EYES_SPRING = { stiffness: 1000, damping: 60 };
/** The head follows the eyes late, and overshoots a little before it settles. */
const HEAD_SPRING = { stiffness: 140, damping: 13 };
/** How a mood settles in when it changes: gently, without overshoot. */
const MOOD_SPRING = { stiffness: 120, damping: 20 };
/**
 * The same, for the eyes' shapes, which ease in script: they stop once within
 * `restDelta` of where they're going and slower than `restSpeed`, far below
 * what shows even on a large face.
 */
const EYE_SHAPE_MOOD_SPRING = { ...MOOD_SPRING, restDelta: 0.01, restSpeed: 0.02 };

/** How far a blink squeezes an eye, and its timing: quick to shut, a beat closed, slower to open. */
const BLINK_CLOSED = 0.1;
const BLINK = { duration: 0.24, times: [0, 0.33, 0.5, 1] };
/** Once the pointer and typing have rested this long, idle glances take over again. */
const WATCHING_REST_MS = 4000;
/** How far open a sleepy bot's eyes flutter, and how long the flutter takes. */
const FLUTTER_OPEN = 0.5;
const FLUTTER_SECONDS = 1.2;
/** The width a face is taken to have, in CSS pixels, while it can't be measured. */
const UNMEASURED_FACE_PIXELS = 128;
/** How long a face's measured size is trusted before it's measured again. */
const FACE_SIZE_TRUSTED_MS = 500;

/** How far a wiggle leans the head to each side, in degrees and viewbox units, and how long one there and back takes. */
const WIGGLE_DEGREES = 6;
const WIGGLE_SHIFT = 0.6;
const WIGGLE_SECONDS = 0.7;
/** Side to side and back: centre, right, centre, left, centre. */
const WIGGLE_SIDES = [0, 1, 0, -1, 0];
const WIGGLE_TIMES = [0, 0.25, 0.5, 0.75, 1];

/** How high a thinking dot rises against its own height, and its timing, like the app's typing dots. */
const DOT_RISE_SHARE = 2.6 / (THINKING_DOT_RADIUS * 2);
const DOT_CYCLE_SECONDS = 1.2;
const DOT_STAGGER_SECONDS = 0.15;
const DOT_BRIGHTEST = 1;

/** How quickly a wiggle or the thinking dots ease back to rest when they stop. */
const STILLING_SECONDS = 0.25;

const easeEachWay = (segments: number): Easing[] =>
	Array.from({ length: segments }, () => "easeInOut");

/**
 * A face's moving parts, held as `look` says; `controls` move it and `drawing`
 * draws it. `face` is the element the face fills, whose size sets how finely
 * its layers move.
 */
export function useFaceRig(
	look: MoodLook,
	face: RefObject<HTMLElement | null>,
): { controls: FaceControls; drawing: FaceDrawing } {
	const [blink] = useState(() => motionValue(1));
	const [flutter] = useState(() => motionValue(0));
	const [layers] = useState<FaceLayers>(() => ({
		...(Object.fromEntries(headLayerNames.map((name) => [name, createRef()])) as Record<
			HeadLayerName,
			LayerRef
		>),
		dots: [createRef(), createRef(), createRef()],
	}));
	const [motions] = useState(() => {
		const facePixels = measuredFacePixels(face);
		return {
			...(Object.fromEntries(
				headLayerNames.map((name) => [
					name,
					new LayerMotion(layers[name], layerKinds[name], facePixels),
				]),
			) as Record<HeadLayerName, LayerMotion>),
			dots: layers.dots.map((dot) => new LayerMotion(dot, layerKinds.dot, facePixels)),
		};
	});
	// Nothing goes on playing once the face is gone.
	useEffect(
		() => () => {
			for (const motion of [...Object.values(motions).flat()]) motion.stop();
		},
		[motions],
	);

	const eyesOpen = useEasedTo(look.eyesOpen);
	const smile = useEasedTo(look.smile);
	const arcsFlat = useEasedTo(look.arcsFlat);
	const dots = useEasedTo(look.dots);
	useMoodPose(motions, look);

	const gaze = useRef({ x: 0, y: 0 });
	const watchedAt = useRef(Number.NEGATIVE_INFINITY);
	const landsAt = useRef(0);
	const [controls] = useState<FaceControls>(() => ({
		lookAt(x, y) {
			const distance = Math.hypot(x - gaze.current.x, y - gaze.current.y);
			gaze.current = { x, y };
			const eyes = [
				viewboxPercentage(x * EYE_TRAVEL_X),
				viewboxPercentage(y * EYE_TRAVEL_Y + Math.abs(x) * EYE_EDGE_DIP),
				1 - Math.abs(x) * EYE_FORESHORTENING,
			];
			motions.eyesGaze.play({ kind: "spring", to: eyes, ...EYES_SPRING });
			motions.gazeMove.play({
				kind: "spring",
				to: [viewboxPercentage(x * HEAD_TRAVEL_X), viewboxPercentage(y * HEAD_TRAVEL_Y)],
				...HEAD_SPRING,
			});
			motions.gazeTilt.play({ kind: "spring", to: [x * HEAD_TILT_DEGREES], ...HEAD_SPRING });
			return distance;
		},
		markWatched() {
			watchedAt.current = performance.now();
		},
		isWatching() {
			return performance.now() - watchedAt.current < WATCHING_REST_MS;
		},
		blink(twice = false) {
			animate(blink, [1, BLINK_CLOSED, BLINK_CLOSED, 1], {
				...BLINK,
				repeat: twice ? 1 : 0,
				repeatDelay: 0.08,
			});
		},
		hop(size = 1) {
			landsAt.current = performance.now() + HOP_SECONDS * 1000;
			const paths = hopPaths(size);
			motions.hopRise.play(paths.rise);
			motions.hopSquash.play(paths.squash);
			motions.hopEyesDrop.play(paths.eyesDrop);
		},
		isAirborne() {
			return performance.now() < landsAt.current;
		},
		wiggle() {
			const swing = (layer: LayerMotion, reach: number) =>
				layer.play(
					{
						kind: "keyframes",
						frames: WIGGLE_SIDES.map((side) => [side * reach]),
						times: WIGGLE_TIMES,
						ease: easeEachWay(WIGGLE_SIDES.length - 1),
						seconds: WIGGLE_SECONDS,
					},
					{ repeat: true },
				);
			swing(motions.wiggleMove, viewboxPercentage(WIGGLE_SHIFT));
			swing(motions.wiggleTilt, WIGGLE_DEGREES);
			return () => {
				easeToRest(motions.wiggleMove);
				easeToRest(motions.wiggleTilt);
			};
		},
		riseDots() {
			const resting = layerKinds.dot.rest;
			const risen = [DOT_RISE_SHARE, DOT_BRIGHTEST];
			motions.dots.forEach((dot, index) => {
				dot.play(
					{
						kind: "keyframes",
						frames: [resting, risen, resting, resting],
						times: [0, 0.3, 0.6, 1],
						ease: easeEachWay(3),
						seconds: DOT_CYCLE_SECONDS,
					},
					{ repeat: true, delaySeconds: index * DOT_STAGGER_SECONDS },
				);
			});
			return () => {
				for (const dot of motions.dots) easeToRest(dot);
			};
		},
		flutter() {
			animate(flutter, [0, FLUTTER_OPEN, 0], {
				duration: FLUTTER_SECONDS,
				times: [0, 0.3, 1],
				ease: ["easeOut", "easeIn"],
			});
		},
	}));

	const eyeHeight = useTransform(
		[blink, eyesOpen, flutter],
		([shut = 1, open = 1, fluttered = 0]: number[]) => shut * Math.max(open, fluttered),
	);
	const drawing: FaceDrawing = {
		layers,
		eyeHeight,
		// The eyes shrink to points as the dots grow from where the eyes were; the middle dot comes last.
		eyesShrink: useTransform(dots, (shown) => 1 - shown),
		smile,
		arcsFlat,
		outerDotsGrow: useTransform(dots, [0, 0.6], [0, 1]),
		middleDotGrows: useTransform(dots, [0.4, 1], [0, 1]),
	};
	return { controls, drawing };
}

/**
 * The face's width in device pixels, for how finely its layers step: measured
 * at most every FACE_SIZE_TRUSTED_MS, and taken as UNMEASURED_FACE_PIXELS while
 * it can't be measured (as with no size yet).
 */
function measuredFacePixels(face: RefObject<HTMLElement | null>): () => number {
	let measured = { pixels: 0, at: Number.NEGATIVE_INFINITY };
	return () => {
		const now = performance.now();
		if (now - measured.at > FACE_SIZE_TRUSTED_MS) {
			const width = face.current?.getBoundingClientRect().width || UNMEASURED_FACE_PIXELS;
			measured = { pixels: width * window.devicePixelRatio, at: now };
		}
		return measured.pixels;
	};
}

/** Eases a layer back to its resting pose. */
function easeToRest(layer: LayerMotion): void {
	layer.play({
		kind: "keyframes",
		frames: [layer.rest, layer.rest],
		times: [0, 1],
		ease: ["easeOut"],
		seconds: STILLING_SECONDS,
	});
}

/** A value tracking `target`, easing to each new one the way a mood settles in. */
function useEasedTo(target: number): MotionValue<number> {
	const value = useSpring(target, EYE_SHAPE_MOOD_SPRING);
	useEffect(() => value.set(target), [value, target]);
	return value;
}

/**
 * Holds the head and eyes as `look` says: eased there gently when the mood
 * changes, and set straight away as the face first appears.
 */
function useMoodPose(
	motions: { moodMove: LayerMotion; moodTilt: LayerMotion; eyesLift: LayerMotion },
	{ headDrop, headLean, eyesLift }: MoodLook,
): void {
	const shown = useRef(false);
	useEffect(() => {
		const poses: [LayerMotion, number[]][] = [
			[motions.moodMove, [viewboxPercentage(headDrop)]],
			[motions.moodTilt, [headLean]],
			[motions.eyesLift, [viewboxPercentage(eyesLift)]],
		];
		for (const [layer, pose] of poses) {
			if (shown.current) layer.play({ kind: "spring", to: pose, ...MOOD_SPRING });
			else layer.jump(pose);
		}
		shown.current = true;
	}, [motions, headDrop, headLean, eyesLift]);
}
