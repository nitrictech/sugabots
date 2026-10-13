import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu.tsx";
import { iconButtonClassName } from "@/ui/icon-button.tsx";

/**
 * The ⋯ button that opens a menu of something's less common actions, such as
 * Download and Delete. `children` are its `DropdownMenuItem`s. `label` names
 * the button, so where there are several on a page say whose it is
 * ("More for Wiki").
 */
export function MoreMenu({ label = "More", children }: { label?: string; children: ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label={label} className={iconButtonClassName("round")}>
				<Ellipsis aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
