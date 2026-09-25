import { type BotColor, botColors } from "@sugabots/avatars";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const POD_ICON_SLOTS = 4;

const podIcon = cva("grid shrink-0 grid-cols-2 p-1.5", {
	variants: {
		size: {
			default: "size-10 gap-0.5 rounded-xl",
			lg: "size-13 gap-1 rounded-2xl",
		},
	},
	defaultVariants: { size: "default" },
});

interface PodIconProps extends VariantProps<typeof podIcon> {
	/** The pod's own colour, behind its bots. */
	tint: BotColor;
	/** The pod's bots, up to four; empty slots show as faint dots. */
	bots: readonly BotColor[];
	className?: string;
}

/** A pod drawn as a tile of its bots' colours. */
export function PodIcon({ tint, bots, size, className }: PodIconProps) {
	const slots = Array.from({ length: POD_ICON_SLOTS }, (_, index) => bots[index]);
	return (
		<span className={cn(podIcon({ size }), botColors[tint].tint, className)}>
			{slots.map((bot, index) => (
				<span
					// Slots are positional and never reorder.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					key={index}
					className={cn("rounded-full", bot ? botColors[bot].swatch : "bg-foreground/5")}
				/>
			))}
		</span>
	);
}
