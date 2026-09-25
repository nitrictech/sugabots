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
 * The design only draws three of these (the accent Send, the bordered
 * secondary, the bare text link); the rest are here to satisfy the contract and
 * are mapped onto tokens above so they cannot drift into a palette of their
 * own. `bare` is the one addition, for a link with no padding.
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
	"focus-ring inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-sans font-semibold transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary-hover",
				secondary:
					"border border-control-border bg-secondary font-medium text-secondary-foreground hover:bg-accent",
				outline:
					"border border-control-border bg-control font-medium text-control-foreground hover:bg-accent",
				ghost: "font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				link: "font-medium text-primary underline-offset-2 hover:underline",
				destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
			},
			size: {
				sm: "h-7 rounded-md px-2.5 text-sm",
				default: "h-8 rounded-md px-3.5 text-md",
				lg: "h-10 rounded-lg px-4 text-base",
				icon: "size-[30px] rounded-md [&_svg]:size-[15px]",
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
