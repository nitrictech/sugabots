import { cn } from "cn";
import { CountBadge } from "./count-badge.tsx";

/**
 * A row of pill-shaped tabs over a list, each showing one part of it, with a
 * count beside a tab's name when it has one. The row scrolls sideways where
 * the tabs are wider than the column.
 */
export function PillTabs<Id extends string>({
	label,
	tabs,
	selected,
	onSelect,
}: {
	/** Names the row for assistive technology. */
	label: string;
	tabs: readonly { id: Id; label: string; count?: number; countLabel?: string }[];
	selected: Id;
	onSelect: (id: Id) => void;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="flex shrink-0 gap-1 overflow-x-auto px-2 pt-2.5 pb-1.5 [scrollbar-width:none]"
		>
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={tab.id === selected}
					onClick={() => onSelect(tab.id)}
					className={cn(
						"focus-ring flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 font-medium text-[13px] transition-colors",
						tab.id === selected
							? "bg-chip text-foreground"
							: "text-muted-foreground hover:text-soft-foreground",
					)}
				>
					{tab.label}
					{tab.count !== undefined && tab.count > 0 && (
						<CountBadge count={tab.count} label={tab.countLabel} size="sm" />
					)}
				</button>
			))}
		</div>
	);
}
