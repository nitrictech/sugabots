import { cn } from "cn";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu.tsx";
import { FLOATING_ON_PHONE, iconButtonClassName } from "@/ui/icon-button.tsx";

/**
 * The ⋯ button that opens a menu of something's less common actions, such as
 * Download and Delete. `children` are its `DropdownMenuItem`s. `label` names
 * the button, so where there are several on a page say whose it is
 * ("More for Wiki").
 */
export function MoreMenu({
	label = "More",
	variant = "round",
	className,
	children,
}: {
	label?: string;
	/** `round` on a card or page; `bar` in a header bar, as `IconButton`'s `bar`. On a phone either floats as glass. */
	variant?: "round" | "bar";
	className?: string;
	children: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				className={cn(iconButtonClassName(variant), FLOATING_ON_PHONE, className)}
			>
				{variant === "bar" ? (
					<Ellipsis aria-hidden size={18} strokeWidth={2} />
				) : (
					<Ellipsis aria-hidden />
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
