import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * A control that is only an icon.
 *
 * `label` is required and does two jobs: it names the button for a screen
 * reader and it is the tooltip. Making it one required prop is the point — the
 * three hand-rolled icon buttons this replaces had three different hover
 * treatments and only some of them had an accessible name.
 *
 * The hover wash comes from `--surface-accent`, so the same component is right
 * in the sidebar, in a panel header and in a dialog without being told which
 * it is in. See the surface tokens in app.css.
 */

const sizes = {
	sm: "size-5 [&_svg]:size-3.5",
	default: "size-6 [&_svg]:size-3.5",
	lg: "size-[30px] [&_svg]:size-[15px]",
} as const;

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
	/** Names the button for assistive technology, and is the tooltip text. */
	label: string;
	children: ReactNode;
	size?: keyof typeof sizes;
	/**
	 * `outline` for a bordered control that sits on a card or panel. `bar` for
	 * one in the header bar across the top of a list, chat or sidebar: a 30px
	 * rounded square, whatever `size`, whose icon keeps the size it is given.
	 * `round` for a close or a ⋯: a 29px filled circle, whatever `size`.
	 */
	variant?: IconButtonVariant;
	side?: "top" | "bottom";
	/**
	 * Render this element instead of a `<button>`. For a link that looks like
	 * an icon button — the settings cog is a route, not an action.
	 */
	render?: useRender.RenderProp;
}

type IconButtonVariant = "quiet" | "outline" | "pane" | "bar" | "round";

/**
 * Merged over a `bar` button beside a phone's large page title, such as
 * Inbox's: sized for a thumb, with its icon to match.
 */
export const ROOMY_ON_PHONE = "max-md:size-10 max-md:rounded-[10px] max-md:[&_svg]:size-5";

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
	return cn(
		"focus-ring grid shrink-0 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none",
		variant === "outline" || variant === "pane" || variant === "round"
			? "bg-chip text-foreground hover:bg-hover"
			: variant === "bar"
				? "rounded-[8px] text-soft-foreground hover:bg-chip"
				: "text-muted-foreground hover:bg-hover hover:text-foreground",
		variant === "bar"
			? "size-[30px]"
			: variant === "round"
				? "size-[29px] [&_svg]:size-4"
				: size === "lg" && variant === "pane"
					? "size-[34px]"
					: sizes[size],
	);
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
			type: render ? undefined : "button",
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
