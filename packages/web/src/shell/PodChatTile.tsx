import { Hash } from "@nitric/suga-icons";
import type { PodColor } from "@sugabots/contracts";
import { cn } from "cn";
import { podPalettes } from "@/shell/PodTile.tsx";

/**
 * Each size the pod's chat tile is drawn at: its corner radius, in pixels, and
 * the class that sizes its icon where it is not the icon's own 16px.
 */
const geometry = {
	26: { radius: 7, iconClassName: undefined },
	28: { radius: 8, iconClassName: undefined },
	64: { radius: 18, iconClassName: "size-8" },
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
	const { radius, iconClassName } = geometry[size];
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
			<Hash className={iconClassName} />
		</span>
	);
}
