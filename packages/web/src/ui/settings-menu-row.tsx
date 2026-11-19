import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { SettingsFieldLabel } from "@/ui/settings-page.tsx";

/**
 * A field row whose value is picked from a menu that opens under its arrow,
 * which turns while the menu is open. `mark` draws an icon beside the value
 * and each option.
 */
export function SettingsMenuRow<Value extends string>({
	label,
	options,
	value,
	mark,
	onChange,
}: {
	label: string;
	options: readonly { value: Value; label: string }[];
	value: Value;
	mark?: (value: Value) => ReactNode;
	onChange: (value: Value) => void;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${label}: ${current?.label ?? value}`}
				className="group focus-ring flex min-h-11.5 w-full cursor-pointer items-center gap-3 border-border border-b px-4 py-2.5 text-left text-sm text-foreground transition-colors last:border-b-0 hover:bg-panel"
			>
				<SettingsFieldLabel>{label}</SettingsFieldLabel>
				<span className="flex min-w-0 flex-1 items-center gap-2.5">
					{mark?.(value)}
					<span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
				</span>
				<ChevronDown
					aria-hidden
					size={15}
					strokeWidth={2.4}
					className="shrink-0 text-subtle-foreground transition-transform group-data-popup-open:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56">
				{options.map((option) => (
					<DropdownMenuItem key={option.value} onClick={() => onChange(option.value)}>
						{mark?.(option.value)}
						{option.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
