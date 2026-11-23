import type { AvatarParts } from "./bot-face.tsx";

/** One face in the crowd, posed by hand. */
interface CrowdMember extends AvatarParts {
	/** Degrees clockwise. */
	rotate: number;
	/** Pixels raised above the row's centre line, at a 40px face. */
	lift: number;
}

/** A loose row of faces, also drawn to assets/bot-crowd.svg. */
export const botCrowd: readonly CrowdMember[] = [
	{ color: "rose", eyes: "dot", rotate: -8, lift: -4 },
	{ color: "yellow", eyes: "pill", rotate: 0, lift: 6 },
	{ color: "purple", eyes: "arc", rotate: 6, lift: 0 },
	{ color: "sky", eyes: "pill", rotate: -4, lift: 10 },
	{ color: "green", eyes: "square", rotate: 0, lift: -2 },
	{ color: "orange", eyes: "dot", rotate: 10, lift: 4 },
	{ color: "ice", eyes: "arc", rotate: 0, lift: 8 },
	{ color: "teal", eyes: "dot", rotate: -6, lift: -3 },
];
