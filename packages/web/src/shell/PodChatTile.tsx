import type { PodColor } from "@sugabots/contracts";
import { cn } from "cn";
import { Hash } from "lucide-react";
import { podPalettes } from "@/shell/PodTile.tsx";

/** Each size the pod's chat tile is drawn at: corner radius and icon size, in pixels. */
const geometry = {
	26: { radius: 7, icon: 14 },
	28: { radius: 8, icon: 15 },
	64: { radius: 18, icon: 30 },
} as const;

/** A pod's chat as a tile: speech bubbles on the pod's colour. */
export function PodChatTile({
	color,
	size,
	className,
}: {
	/** `null` draws the neutral tile, as a Personal pod has. */
	color: PodColor | null;
	size: keyof typeof geometry;
	className?: string;
}) {
	const { radius, icon } = geometry[size];
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 place-items-center text-foreground",
				color === null && "bg-tile",
				className,
			)}
			style={{
				width: size,
				height: size,
				borderRadius: radius,
				background: color === null ? undefined : podPalettes[color].tile,
			}}
		>
			<Hash size={icon} strokeWidth={2} />
		</span>
	);
}
