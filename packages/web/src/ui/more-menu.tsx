import { cn } from "cn";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu.tsx";
import { FLOATING_ON_PHONE, iconButtonClassName } from "@/ui/icon-button.tsx";

/**
 * The ⋯ button that opens a menu of something's less common actions, such as
 * Download and Delete. `children` are its `DropdownMenuItem`s. `label` names
 * the button, so where there are several on a page say whose it is
 * ("More for Wiki"). `variant` is the `IconButton` look it takes: a filled
 * circle unless it sits in a header bar beside other `bar` buttons.
 */
export function MoreMenu({
	label = "More",
	variant = "round",
	children,
}: {
	label?: string;
	variant?: "round" | "bar";
	children: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				className={cn(
					iconButtonClassName(variant),
					// A `bar` button leaves its icon the size it is given, which here is the same as Close beside it.
					variant === "bar" && "md:[&_svg]:size-4",
					FLOATING_ON_PHONE,
				)}
			>
				<Ellipsis aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
