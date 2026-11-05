import type { FaceControls, MoodLook } from "./face-rig.ts";
import { randomIn, type Span } from "./random.ts";

/**
 * One way a bot carries itself: how it holds its face, and what it does while
 * it's in the mood. Adding a mood is adding its name to `botMoods` and an entry to `moods`.
 */
interface Mood {
	look: MoodLook;
	/** Where it looks as the mood starts, from -1 to 1 on each axis; straight ahead unless given. */
	gaze?: { x: number; y: number };
	/** Whether its eyes may follow the pointer and typing, when the face is asked to watch them. */
	watches?: boolean;
	/** Starts what goes on for as long as the mood lasts; returns what eases it to a stop. */
	start?: (face: FaceControls) => () => void;
	/** A small act it repeats, after a pause in seconds picked from `pause` each time; the first from `firstPause`, when given. */
	act?: { run: (face: FaceControls) => void; pause: Span; firstPause?: Span };
}

const restingLook: MoodLook = {
	eyesOpen: 1,
	smile: 0,
	arcsFlat: 0,
	dots: 0,
	eyesLift: 0,
	headDrop: 0,
	headLean: 0,
};

/** The moods a bot can be in, in the order they're listed. Adding one is adding it here and to `moods`. */
export const botMoods = ["still", "idle", "thinking", "happy", "excited", "sleepy"] as const;

export type BotMood = (typeof botMoods)[number];

/**
 * - still: as `BotFace` draws it, unmoving until it's asked to hop.
 * - idle: glances about and blinks, and watches the pointer and typing if asked.
 * - thinking: its eyes shrink away into three dots that rise in turn, as a
 *   bot's typing indicator does.
 * - happy: closes its eyes into smiling arcs, faces you, and gives little bounces.
 * - excited: eyes wide and fixed on you, it wiggles from side to side and
 *   bounces on the spot, with now and then a full hop, never quite in rhythm.
 * - sleepy: lids almost shut, head drooping; its eyes flutter half open now
 *   and then.
 */
export const moods: Record<BotMood, Mood> = {
	still: { look: restingLook },
	idle: {
		look: { ...restingLook },
		watches: true,
		// Soon after it starts, so even a short turn at being idle shows.
		act: {
			run: glanceOrBlink,
			pause: { least: 1.2, most: 3.8 },
			firstPause: { least: 0.2, most: 0.7 },
		},
	},
	thinking: {
		look: { ...restingLook, dots: 1 },
		start: (face) => face.riseDots(),
	},
	happy: {
		look: {
			...restingLook,
			eyesOpen: 0,
			smile: 1,
			eyesLift: -1,
		},
		watches: true,
		act: { run: bounceOrBlink, pause: { least: 1.4, most: 3.2 } },
	},
	excited: {
		look: {
			...restingLook,
			eyesOpen: 1.15,
			eyesLift: -0.5,
		},
		start: (face) => {
			face.hop();
			return face.wiggle();
		},
		// A short, uneven wait after each landing before the next bounce.
		act: { run: bounceOrHop, pause: { least: 0.12, most: 0.45 } },
	},
	sleepy: {
		look: {
			...restingLook,
			eyesOpen: 0.12,
			arcsFlat: 0.85,
			eyesLift: 1.2,
			headDrop: 1.2,
			headLean: 5,
		},
		gaze: { x: 0, y: 0.4 },
		act: { run: maybeFlutter, pause: { least: 3, most: 7 } },
	},
};

/** How often an idle bot blinks instead of glancing, and how often a blink is a double one. */
export const IDLE_BLINK_CHANCE = 0.3;
export const DOUBLE_BLINK_CHANCE = 0.2;
/** How often an idle bot's glance is back to straight ahead, rather than somewhere new. */
export const LOOK_AHEAD_CHANCE = 0.35;
/** How far an idle bot glances, at most, from straight ahead. */
export const IDLE_GLANCE_REACH = 1;
/** How far the eyes must turn for a glance to count as long, and how often a bot blinks with one. */
export const LONG_GLANCE_DISTANCE = 0.6;
export const LONG_GLANCE_BLINK_CHANCE = 0.5;

/** Blinks now and then; otherwise glances somewhere new, unless it's watching the pointer or typing. */
function glanceOrBlink(face: FaceControls): void {
	if (face.isWatching() || Math.random() < IDLE_BLINK_CHANCE) {
		face.blink(Math.random() < DOUBLE_BLINK_CHANCE);
		return;
	}
	const [x, y] = Math.random() < LOOK_AHEAD_CHANCE ? [0, 0] : randomGlance(IDLE_GLANCE_REACH);
	// People blink as their eyes shift a long way.
	if (face.lookAt(x, y) > LONG_GLANCE_DISTANCE && Math.random() < LONG_GLANCE_BLINK_CHANCE) {
		face.blink();
	}
}

/** How big a happy bot's little bounces are, against a full hop. */
export const HAPPY_BOUNCE = 0.4;
/**
 * How often a happy bot's act is a bounce, and how often a blink; otherwise it
 * glances, by at most `HAPPY_GLANCE_REACH`, so it keeps its face towards you.
 */
export const HAPPY_BOUNCE_CHANCE = 0.45;
export const HAPPY_BLINK_CHANCE = 0.25;
export const HAPPY_GLANCE_REACH = 0.4;

function bounceOrBlink(face: FaceControls): void {
	const roll = Math.random();
	if (roll < HAPPY_BOUNCE_CHANCE) face.hop(HAPPY_BOUNCE);
	else if (roll < HAPPY_BOUNCE_CHANCE + HAPPY_BLINK_CHANCE) face.blink();
	else if (!face.isWatching()) face.lookAt(...randomGlance(HAPPY_GLANCE_REACH));
}

/** How big an excited bot's bounces on the spot are against a full hop, and how often one is a full hop instead. */
export const EXCITED_BOUNCE: Span = { least: 0.25, most: 0.5 };
export const EXCITED_FULL_HOP_CHANCE = 0.3;

function bounceOrHop(face: FaceControls): void {
	// Never cuts a hop short in the air.
	if (face.isAirborne()) return;
	face.hop(Math.random() < EXCITED_FULL_HOP_CHANCE ? 1 : randomIn(EXCITED_BOUNCE));
}

/** How often a sleepy bot's act is a flutter; otherwise it does nothing. */
export const FLUTTER_CHANCE = 0.5;

function maybeFlutter(face: FaceControls): void {
	if (Math.random() < FLUTTER_CHANCE) face.flutter();
}

/**
 * A glance goes at least `GLANCE_LEAST_SHARE` of its reach from straight
 * ahead, and only `GLANCE_VERTICAL_SHARE` as far up or down as sideways.
 */
export const GLANCE_LEAST_SHARE = 0.5;
export const GLANCE_VERTICAL_SHARE = 0.6;

/** Somewhere to glance, up to `reach` from straight ahead, in any direction. */
function randomGlance(reach: number): [number, number] {
	const angle = Math.random() * Math.PI * 2;
	const distance = (GLANCE_LEAST_SHARE + Math.random() * (1 - GLANCE_LEAST_SHARE)) * reach;
	return [Math.cos(angle) * distance, Math.sin(angle) * distance * GLANCE_VERTICAL_SHARE];
}
