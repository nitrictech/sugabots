import type { BotLook } from "./bot-face.tsx";

/** One face in the crowd, posed by hand. */
export interface CrowdMember extends BotLook {
	/** Degrees clockwise. */
	rotate: number;
	/** Pixels raised above the row's centre line, at a 40px face. */
	lift: number;
}

/** A loose row of faces, also drawn to assets/bot-crowd.svg. */
export const botCrowd: readonly CrowdMember[] = [
	{ color: "rose", face: "dots", rotate: -8, lift: -4 },
	{ color: "yellow", face: "bar", rotate: 0, lift: 6 },
	{ color: "purple", face: "smile", rotate: 6, lift: 0 },
	{ color: "sky", face: "bar", rotate: -4, lift: 10 },
	{ color: "green", face: "square", rotate: 0, lift: -2 },
	{ color: "orange", face: "dots", rotate: 10, lift: 4 },
	{ color: "cyan", face: "smile", rotate: 0, lift: 8 },
	{ color: "teal", face: "dots", rotate: -6, lift: -3 },
];
