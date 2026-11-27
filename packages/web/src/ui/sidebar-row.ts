import { cva } from "class-variance-authority";

/**
 * A row of a sidebar or the icon rail: a link or button 32px tall, shaded
 * while it is the one open and under the pointer otherwise. `phone` makes it
 * 44px for a thumb on a phone, as a phone's own lists are.
 */
export const sidebarRow = cva(
	"focus-ring flex h-8 min-w-0 items-center gap-2.5 pr-1.5 pl-2 text-sm transition-colors",
	{
		variants: {
			selected: {
				true: "bg-row-selected text-foreground",
				false: "text-muted-foreground hover:bg-row-hover hover:text-foreground",
			},
			/** The main sidebar's rows are `sm`; an owner's sidebar's are `md`. */
			radius: { sm: "rounded-sm", md: "rounded-md" },
			phone: {
				true: "max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-base max-md:active:bg-row-selected",
				false: "",
			},
		},
		defaultVariants: { selected: false, radius: "sm", phone: false },
	},
);
