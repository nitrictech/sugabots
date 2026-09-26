import { BotFace, type BotLook } from "@sugabots/avatars";
import { cn } from "cn";

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
 * colour and eyes. Slots with no bot are faint discs, so an empty pod is still
 * a pod.
 */
export function PodTile({
	bots,
	size,
	className,
}: {
	/** The pod's bots in the order the pod lists them; only the first four are drawn. */
	bots: readonly BotLook[];
	size: PodTileSize;
	className?: string;
}) {
	const { radius, gap, padding } = geometry[size];
	return (
		<span
			aria-hidden
			className={cn("grid shrink-0 grid-cols-2 grid-rows-2 bg-tile", className)}
			style={{
				width: size,
				height: size,
				borderRadius: radius,
				gap,
				padding,
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
					<span key={slot} className="rounded-full bg-tile-empty" />
				);
			})}
		</span>
	);
}
