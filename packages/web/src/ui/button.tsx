import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/*
 * The button. An icon-only control is an `IconButton`, which requires a label. A link
 * styled as a button gets `buttonStyles(...)` on its `<a>`, so it stays a link.
 */

export const buttonStyles = cva(
	"focus-ring inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-sans font-semibold transition-colors disabled:cursor-default [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-chip disabled:text-disabled-foreground",
				secondary: "bg-chip text-foreground hover:bg-hover disabled:text-disabled-foreground",
				/** A secondary answer beside a primary one on a card, a step stronger than `secondary` so it reads on the card's fill. */
				muted: "bg-hover text-foreground hover:bg-hover-strong disabled:text-disabled-foreground",
				ghost:
					"font-medium text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50",
				link: "rounded-md font-medium text-link hover:opacity-80 disabled:text-disabled-foreground",
				destructive: "font-medium text-destructive-text hover:opacity-80 disabled:opacity-50",
				/** Text that brightens under the pointer, for a small action beside a list, such as View all. */
				quiet: "font-normal text-subtle-foreground hover:text-foreground disabled:opacity-50",
			},
			size: {
				sm: "h-7.25 px-3.5 text-xs",
				default: "h-9 px-4 text-sm",
				lg: "h-12 px-5 text-sm",
				bare: "h-auto p-0",
				/** Bare, in the small text of a row's end or a note. */
				text: "h-auto p-0 text-xs",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonStyles>;

/** Button styles labelled actions. Use IconButton for icon-only actions requiring a tooltip. */
export function Button({ className, variant, size, ...props }: ButtonProps) {
	return <ButtonPrimitive className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
