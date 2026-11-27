import { cn } from "cn";
import { Search } from "lucide-react";
import { type KeyboardEvent, useDeferredValue, useState } from "react";

/*
 * A box to search a list by typing, with a magnifier at its start. Escape
 * clears it. It is a `search` input, so the browser's own clear button is
 * hidden: Escape does that job.
 */

const looks = {
	/** At the top of a dialog's list, as a pill. */
	dialog: {
		box: "gap-2 rounded-xl bg-chip px-3",
		icon: "text-muted-foreground",
		iconSize: 15,
		input: "py-2 text-sm placeholder:text-muted-foreground",
	},
	/** In a sidebar, as tall as its rows. */
	sidebar: {
		box: "h-8 gap-2 rounded-md bg-chip px-2",
		icon: "text-subtle-foreground",
		iconSize: 14,
		input: "text-sm placeholder:text-subtle-foreground",
	},
	/** On a settings card, edged in a hairline over the card's fill. */
	outline: {
		box: "h-9 gap-2 rounded-lg border border-border-strong bg-background px-2.5",
		icon: "text-subtle-foreground",
		iconSize: 14,
		input: "text-xs placeholder:text-subtle-foreground",
	},
} as const;

export function SearchField({
	label,
	value,
	onChange,
	placeholder = label,
	look = "dialog",
	autoComplete,
	onKeyDown,
	className,
}: {
	/** Names the field for assistive technology, such as "Search models". */
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	look?: keyof typeof looks;
	autoComplete?: string;
	/** Keys other than the Escape that clears it, such as arrows into the list it searches. */
	onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	className?: string;
}) {
	const { box, icon, iconSize, input } = looks[look];
	return (
		<label className={cn("focus-ring-within flex min-w-0 items-center", box, className)}>
			<Search aria-hidden size={iconSize} strokeWidth={2} className={cn("shrink-0", icon)} />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || value === "") return onKeyDown?.(event);
					// Clearing takes this Escape, so a dialog around the field stays open.
					event.stopPropagation();
					onChange("");
				}}
				placeholder={placeholder}
				autoComplete={autoComplete}
				aria-label={label}
				className={cn(
					"min-w-0 flex-1 bg-transparent text-foreground outline-none [&::-webkit-search-cancel-button]:hidden",
					input,
				)}
			/>
		</label>
	);
}

/**
 * What a `SearchField` typed into, and the items whose `fields` hold it,
 * ignoring case and the spaces around it. Every item matches while nothing is
 * typed. The matching trails the typing, so a long list doesn't hold a key up.
 */
export function useSearchFilter<Item>(
	items: readonly Item[],
	fields: (item: Item) => readonly (string | null | undefined)[],
): {
	query: string;
	setQuery: (query: string) => void;
	/** Whether something is typed, so the list can say no match differently from empty. */
	searching: boolean;
	matches: readonly Item[];
} {
	const [query, setQuery] = useState("");
	const deferred = useDeferredValue(query);
	const searching = deferred.trim() !== "";
	const matches = searching ? items.filter((item) => matchesSearch(fields(item), deferred)) : items;
	return { query, setQuery, searching, matches };
}

/**
 * Whether one of `fields` holds `query`, ignoring case and the spaces around
 * it. Anything matches an empty query.
 */
export function matchesSearch(
	fields: readonly (string | null | undefined)[],
	query: string,
): boolean {
	const needle = query.trim().toLowerCase();
	return needle === "" || fields.some((field) => field?.toLowerCase().includes(needle) ?? false);
}
