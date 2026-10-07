import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/*
 * The button.
 *
 * The variant and size names are shadcn's, not ours, and that is deliberate:
 * AI Elements is a shadcn registry, and every component we install from it
 * reaches for `<Button variant="outline" size="icon">`. Keeping the API
 * identical means an installed component uses *this* button — styled to the
 * design — instead of the CLI overwriting it with the library's default and
 * quietly introducing a second look.
 *
 * The design draws buttons as pills: the accent primary, a neutral chip for
 * everything secondary (`muted` where it sits on a card's fill), and bare
 * text for links and destructive actions. The rest are here to satisfy the
 * contract and are mapped onto those so they cannot drift into a palette of
 * their own. `bare` is the one addition, for a link with no padding.
 *
 * An icon-only control should still be `IconButton`, which requires a label.
 * `size="icon"` exists for registry components that do not know about it.
 *
 * To render something other than a `<button>` with this styling, pass the
 * element as `render` — Base UI's replacement for Radix's `asChild` — and
 * `nativeButton={false}` if it is not a button. Base UI then gives it the
 * button role, so a link is not rendered this way: give the `<a>`
 * `buttonStyles(...)` instead, and it stays a link.
 */

export const buttonStyles = cva(
	"focus-ring inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-sans font-semibold transition-colors disabled:cursor-default [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-chip disabled:text-disabled-foreground",
				secondary: "bg-chip text-foreground hover:bg-hover disabled:text-disabled-foreground",
				/** A secondary answer beside a primary one on a card, a step stronger than `secondary` so it reads on the card's fill. */
				muted: "bg-hover text-foreground hover:bg-hover-strong disabled:text-disabled-foreground",
				outline: "bg-chip text-foreground hover:bg-hover disabled:text-disabled-foreground",
				ghost:
					"font-medium text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50",
				link: "rounded-md font-medium text-link hover:opacity-80 disabled:text-disabled-foreground",
				destructive: "font-medium text-destructive-text hover:opacity-80 disabled:opacity-50",
			},
			size: {
				sm: "h-[29px] px-3.5 text-md",
				default: "h-9 px-4 text-[14px]",
				lg: "h-12 px-5 text-lg",
				icon: "size-[34px] [&_svg]:size-[15px]",
				bare: "h-auto p-0",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonStyles>;

/** Button styles labelled actions. Use IconButton for icon-only actions requiring a tooltip. */
export function Button({ className, variant, size, ...props }: ButtonProps) {
	return <ButtonPrimitive className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
