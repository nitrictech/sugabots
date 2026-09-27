import { BotFace, type BotLook } from "@sugabots/avatars";
import type { PodColor } from "@sugabots/contracts";
import { cn } from "cn";

/**
 * How each pod colour is drawn: the tile, a slot in it with no bot, and the
 * swatch a colour picker shows for it. One oklch recipe on each colour's hue:
 * tile L .9 C .05 light and L .36 C .065 dark, empty slot L .84 C .07 light
 * and L .45 C .07 dark, swatch L .7 C .16 in both, as vivid as a bot's face.
 */
export const podPalettes: Record<PodColor, { tile: string; empty: string; swatch: string }> = {
	green: tint(148),
	blue: tint(255),
	plum: tint(340),
	amber: tint(78),
	teal: tint(192),
	purple: tint(298),
	rose: tint(18),
	orange: tint(50),
};

function tint(hue: number) {
	return {
		tile: `light-dark(oklch(0.9 0.05 ${hue}), oklch(0.36 0.065 ${hue}))`,
		empty: `light-dark(oklch(0.84 0.07 ${hue}), oklch(0.45 0.07 ${hue}))`,
		swatch: `oklch(0.7 0.16 ${hue})`,
	};
}

/**
 * The design's tile at each size it draws one: corner radius, and the gap and
 * padding around the 2×2 grid of faces, all in pixels.
 */
const geometry = {
	20: { radius: 7, gap: 1.5, padding: 3 },
	28: { radius: 9, gap: 2, padding: 4 },
	30: { radius: 9, gap: 2, padding: 4 },
	36: { radius: 11, gap: 2, padding: 4 },
	44: { radius: 14, gap: 3, padding: 5 },
	46: { radius: 14, gap: 3, padding: 5 },
	72: { radius: 22, gap: 5, padding: 9 },
	88: { radius: 26, gap: 6, padding: 10 },
} as const;

export type PodTileSize = keyof typeof geometry;

/** The tile's four places, in reading order. */
const SLOTS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

/**
 * A pod as a rounded square of its first four bots' faces, each in its own
 * colour and eyes, on the pod's own colour. Slots with no bot are faint discs,
 * so an empty pod is still a pod.
 */
export function PodTile({
	bots,
	color,
	size,
	className,
}: {
	/** The pod's bots in the order the pod lists them; only the first four are drawn. */
	bots: readonly BotLook[];
	/** `null` draws the neutral tile, as All and a Personal pod have. */
	color: PodColor | null;
	size: PodTileSize;
	className?: string;
}) {
	const { radius, gap, padding } = geometry[size];
	const palette = color === null ? undefined : podPalettes[color];
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 grid-cols-2 grid-rows-2",
				palette === undefined && "bg-tile",
				className,
			)}
			style={{
				width: size,
				height: size,
				borderRadius: radius,
				gap,
				padding,
				background: palette?.tile,
			}}
		>
			{SLOTS.map((slot, index) => {
				const bot = bots[index];
				return bot ? (
					// `overflow` because most sizes give a fractional cell, and a
					// viewport snapped to whole pixels would shave the disc's edge.
					<BotFace
						key={slot}
						color={bot.color}
						face={bot.face}
						overflow="visible"
						className="size-full min-h-0 min-w-0"
					/>
				) : (
					<span
						key={slot}
						className={cn("rounded-full", palette === undefined && "bg-tile-empty")}
						style={{ background: palette?.empty }}
					/>
				);
			})}
		</span>
	);
}
