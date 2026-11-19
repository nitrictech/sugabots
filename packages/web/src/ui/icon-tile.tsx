import { cn } from "cn";
import type { ReactNode } from "react";

const SIZES = {
	/** Heading a card or a stage. */
	sm: "size-7 rounded-sm [&_svg]:size-3.75",
	/** At the start of a file's row. */
	md: "size-8 rounded-md [&_svg]:size-4",
} as const;

const TONES = {
	chip: "bg-chip text-muted-foreground",
	/** On a card's fill, where the chip colour would not show. */
	tile: "bg-tile text-soft-foreground",
	/** For something deleted. */
	faded: "bg-chip text-subtle-foreground",
} as const;

/** The square an icon sits on to mark what kind of thing a row, card or stage shows. Hidden from assistive technology. */
export function IconTile({
	size,
	tone = "chip",
	children,
}: {
	size: keyof typeof SIZES;
	tone?: keyof typeof TONES;
	/** The icon. */
	children: ReactNode;
}) {
	return (
		<span aria-hidden className={cn("grid shrink-0 place-items-center", SIZES[size], TONES[tone])}>
			{children}
		</span>
	);
}
