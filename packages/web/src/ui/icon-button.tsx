import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * A control that is only an icon.
 *
 * `label` is required and does two jobs: it names the button for a screen
 * reader and it is the tooltip, so no icon button goes without an accessible
 * name.
 */

const sizes = {
	sm: "size-5 [&_svg]:size-3.5",
	default: "size-6 [&_svg]:size-3.5",
	lg: "size-7.5 [&_svg]:size-3.75",
} as const;

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
	/** Names the button for assistive technology, and is the tooltip text. */
	label: string;
	children: ReactNode;
	size?: keyof typeof sizes;
	/**
	 * `quiet` for a small control with no background until hovered. `bar` for
	 * one in the header bar across the top of a list, chat or sidebar: a 30px
	 * rounded square, whatever `size`, whose icon keeps the size it is given.
	 * `round` for a close or a ⋯: a 29px filled circle, whatever `size`.
	 * `toolbar` for one of a row of small actions over a message: a 28px
	 * rounded square. `row` for one beside a sidebar's rows: a 32px rounded
	 * square, shaded as a row is while it is the page open or its menu is.
	 * `destructive` for removing one item from a list: a 28px circle in the
	 * destructive colour.
	 */
	variant?: IconButtonVariant;
	side?: "top" | "bottom";
	/**
	 * Render this element instead of a `<button>`. For a link that looks like
	 * an icon button — the settings cog is a route, not an action.
	 */
	render?: useRender.RenderProp;
}

type IconButtonVariant = "quiet" | "bar" | "round" | "toolbar" | "row" | "destructive";

/** The variants drawn at one size whatever `size` says, and how. */
const FIXED_SIZE_VARIANTS: Partial<Record<IconButtonVariant, string>> = {
	bar: "size-7.5 rounded-md text-soft-foreground hover:bg-chip",
	round: "size-7.25 bg-chip text-foreground hover:bg-hover [&_svg]:size-4",
	toolbar:
		"size-7 rounded-md text-subtle-foreground hover:bg-chip hover:text-foreground [&_svg]:size-3.75",
	row: "size-8 rounded-md text-subtle-foreground hover:bg-row-hover hover:text-foreground aria-[current=page]:bg-row-selected aria-[current=page]:text-foreground data-popup-open:bg-row-hover [&_svg]:size-3.75",
	destructive: "size-7 text-destructive-text hover:bg-destructive-hover",
};

/**
 * Merged over a `bar` button in a chat's header: on a phone it floats over the
 * chat as a round glass button, 44px as a phone's own are, as Back there does,
 * darker while pressed or while the menu it opens is open.
 */
export const FLOATING_ON_PHONE =
	"max-md:size-11 max-md:rounded-full max-md:text-foreground max-md:glass max-md:[&_svg]:size-5 max-md:active:bg-hover-strong max-md:data-popup-open:bg-hover-strong";

/**
 * An `IconButton`'s look, for a control that has to be another element, such
 * as the trigger of a menu.
 */
export function iconButtonClassName(
	variant: IconButtonVariant = "quiet",
	size: keyof typeof sizes = "default",
): string {
	const base =
		"focus-ring grid shrink-0 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none";
	const fixed = FIXED_SIZE_VARIANTS[variant];
	if (fixed) return cn(base, fixed);
	return cn(base, "text-muted-foreground hover:bg-hover hover:text-foreground", sizes[size]);
}

/** IconButton uses label for both its accessible name and tooltip, with surface-relative styling. */
export function IconButton({
	label,
	children,
	size = "default",
	variant = "quiet",
	side = "bottom",
	render,
	className,
	...props
}: IconButtonProps) {
	const button = useRender({
		render,
		defaultTagName: "button",
		props: {
			// Omitted, not undefined, with `render`: undefined would erase a rendered
			// close's own type="button", so it would submit its form.
			...(render ? {} : { type: "button" as const }),
			"aria-label": label,
			className: cn(iconButtonClassName(variant, size), className),
			children,
			...props,
		},
	});

	return (
		<Tooltip label={label} side={side}>
			{button}
		</Tooltip>
	);
}
