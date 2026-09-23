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
	/** `outline` for a bordered control that sits on a card or panel. */
	variant?: "quiet" | "outline" | "pane";
	side?: "top" | "bottom";
	/**
	 * Render this element instead of a `<button>`. For a link that looks like
	 * an icon button — the settings cog is a route, not an action.
	 */
	render?: useRender.RenderProp;
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
			className: cn(
				"focus-ring grid shrink-0 cursor-pointer place-items-center rounded-md transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none",
				variant === "outline"
					? "border border-control-border bg-control text-control-foreground hover:bg-surface-accent"
					: variant === "pane"
						? "rounded-xl bg-sunken text-muted-foreground hover:text-heading"
						: "text-surface-muted-foreground hover:bg-surface-accent hover:text-surface-accent-foreground",
				size === "lg" && variant === "pane" ? "size-9" : sizes[size],
				className,
			),
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
