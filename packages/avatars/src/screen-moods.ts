import type { MoodLoop } from "./mood-loop.ts";

/*
 * The moods bots' faces move through on the apps' screens, here beside the
 * moods themselves so every app moves its faces the same way.
 */

/**
 * How a bot's face carries itself while someone writes to it: watching them,
 * now and then briefly pleased or excited.
 */
export const WATCHING_MOODS: MoodLoop = [
	{ mood: "idle", weight: 1, seconds: { least: 25, most: 60 } },
	{ mood: "happy", weight: 2, seconds: { least: 1.5, most: 2.5 } },
	{ mood: "excited", weight: 1, seconds: { least: 1, most: 1.5 } },
];

/**
 * How the bot being made carries itself: mostly at ease, often pleased, and
 * now and then briefly excited.
 */
export const CREATION_MOODS: MoodLoop = [
	{ mood: "idle", weight: 1, seconds: { least: 4, most: 9 } },
	{ mood: "happy", weight: 3, seconds: { least: 2, most: 4 } },
	{ mood: "excited", weight: 1, seconds: { least: 1.2, most: 2 } },
];
