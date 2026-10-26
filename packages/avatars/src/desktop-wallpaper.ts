import { botColors } from "./bot-colors.ts";
import type { CrowdMember } from "./bot-crowd.ts";
import type { BotLook } from "./bot-look.ts";
import { placedBotFaceSvg } from "./face-svg.ts";

/**
 * Wallpapers for the sandbox's desktops: a crowd for a desktop that is
 * nobody's, and an agent's own face on the desktop it drives. Both are flat:
 * a gradient this dark bands on the desktop's 8-bit display.
 */

/** The sandbox's display, in pixels: `sugabots-desktop` starts Xvfb at this size. */
const DESKTOP_WIDTH_PX = 1280;
const DESKTOP_HEIGHT_PX = 800;
/** A deep indigo on the accent's hue, lighter than the windows' near-black so they stand off it. */
const DESKTOP_GROUND_HEX = "#1b1f3b";

/** How an agent's desktop shows whose it is. */
export interface AgentDesktopLook {
	/** An SVG for the whole screen: the agent's face, large and faint, in the corner above the dock. */
	wallpaperSvg: string;
	/** The edge of the focused window: the agent's colour, as `#RRGGBB`. */
	accent: string;
}

/** The look of an agent's desktop, for `sugabots-desktop desktop` and `session`. */
export function agentDesktopLook(look: BotLook): AgentDesktopLook {
	const facePx = 600;
	// Mostly off the bottom-right corner, so windows in the middle cover little of it.
	const face = placedBotFaceSvg(look, DESKTOP_WIDTH_PX - 430, DESKTOP_HEIGHT_PX - 400, facePx, -8);
	return {
		wallpaperSvg: desktopSvg(`<g opacity="${AGENT_FACE_OPACITY}">${face}</g>`),
		accent: botColors[look.color].face,
	};
}

/** Faint enough that windows' text over it stays the thing to read. */
const AGENT_FACE_OPACITY = 0.18;

/**
 * The wallpaper of a desktop Sugabots gives none, as the image ships it: a
 * loose row with one bot in each of a spread of head shapes, centred a little
 * above the middle.
 */
export function crowdWallpaperSvg(): string {
	const facePx = 64;
	const gapPx = 22;
	/** The crowd's lifts are measured at a 40px face, as `botCrowd`'s are. */
	const liftScale = facePx / 40;
	const rowWidth = wallpaperCrowd.length * facePx + (wallpaperCrowd.length - 1) * gapPx;
	const left = (DESKTOP_WIDTH_PX - rowWidth) / 2;
	// Above the middle, so the dock at the bottom doesn't weigh the screen down.
	const centreY = DESKTOP_HEIGHT_PX * 0.45;
	const faces = wallpaperCrowd.map((bot, index) =>
		placedBotFaceSvg(
			bot,
			left + index * (facePx + gapPx),
			centreY - facePx / 2 - bot.lift * liftScale,
			facePx,
			bot.rotate,
		),
	);
	return desktopSvg(faces.join(""));
}

function desktopSvg(content: string): string {
	const ground = `<rect width="${DESKTOP_WIDTH_PX}" height="${DESKTOP_HEIGHT_PX}" fill="${DESKTOP_GROUND_HEX}"/>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${DESKTOP_WIDTH_PX}" height="${DESKTOP_HEIGHT_PX}" viewBox="0 0 ${DESKTOP_WIDTH_PX} ${DESKTOP_HEIGHT_PX}">${ground}${content}</svg>\n`;
}

/** Posed by hand like `botCrowd`. */
const wallpaperCrowd: readonly CrowdMember[] = [
	{ color: "rose", face: "dot", shape: "bear", rotate: -8, lift: -4 },
	{ color: "amber", face: "pill", shape: "squircle", rotate: 4, lift: 6 },
	{ color: "purple", face: "arc", shape: "flower", rotate: 6, lift: -1 },
	{ color: "sky", face: "pill", shape: "antenna", rotate: -4, lift: 9 },
	{ color: "green", face: "square", shape: "hexagon", rotate: 0, lift: -3 },
	{ color: "orange", face: "wink", shape: "ghost", rotate: 8, lift: 5 },
	{ color: "ice", face: "arc", shape: "blob", rotate: 0, lift: 10 },
	{ color: "fuchsia", face: "dot", shape: "star", rotate: -6, lift: -2 },
	{ color: "teal", face: "pill", shape: "dome", rotate: 3, lift: 6 },
	{ color: "yellow", face: "square", shape: "scallop", rotate: -5, lift: 0 },
	{ color: "indigo", face: "dot", shape: "drop", rotate: 6, lift: 8 },
];
