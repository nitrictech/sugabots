import { cn } from "cn";
import {
	type EmojiPickerListComponents,
	EmojiPicker as EmojiPickerPrimitive,
	useEmojiDetails,
} from "frimousse";
import { Suspense, useState } from "react";
import { resolveEmojiData } from "@/lib/emoji.ts";
import { useRecentEmoji } from "@/lib/recent-emoji.ts";

/*
 * A searchable grid of every emoji, by category, with a skin tone to pick
 * them in, and over it a row of the ones last chosen in this browser. The
 * emoji are the app's own, built with it, so opening it reaches no other
 * site, and once they have loaded for the page it opens with them at once.
 * Typing filters the grid, by name or shortcode, and hides the recent row,
 * the arrow keys move through the grid, and Enter chooses.
 */

const COLUMNS = 9;

export function EmojiPicker({
	onSelect,
	className,
}: {
	/** The emoji chosen, as text, with its skin tone. */
	onSelect: (emoji: string) => void;
	className?: string;
}) {
	const [search, setSearch] = useState("");
	const [recent, remember] = useRecentEmoji();
	function choose(emoji: string) {
		remember(emoji);
		onSelect(emoji);
	}
	return (
		<EmojiPickerPrimitive.Root
			resolveEmojiData={resolveEmojiData}
			columns={COLUMNS}
			onEmojiSelect={({ emoji }) => choose(emoji)}
			className={cn("isolate flex h-[332px] w-[332px] max-w-full flex-col", className)}
		>
			<div className="p-2 pb-1">
				<EmojiPickerPrimitive.Search
					aria-label="Search emoji"
					placeholder="Search emoji"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="focus-ring h-8 w-full rounded-tail border border-border-strong bg-background px-2.5 text-base text-foreground placeholder:text-subtle-foreground"
				/>
			</div>
			{recent.length > 0 && !search && (
				<section aria-label="Recent">
					<div className={CATEGORY_HEADER}>Recent</div>
					<div className="flex px-1.5">
						{recent.map((emoji) => (
							<Suspense
								key={emoji}
								fallback={<RecentEmoji emoji={emoji} label={emoji} onChoose={choose} />}
							>
								<NamedRecentEmoji emoji={emoji} onChoose={choose} />
							</Suspense>
						))}
					</div>
				</section>
			)}
			{/* Focusable, so the keyboard can scroll it as well as move through it from the search. */}
			<EmojiPickerPrimitive.Viewport
				tabIndex={0}
				aria-label="Emoji"
				className="relative flex-1 rounded-tail outline-hidden focus-visible:shadow-[inset_var(--ring-shadow)]"
			>
				<EmojiPickerPrimitive.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
					Loading…
				</EmojiPickerPrimitive.Loading>
				<EmojiPickerPrimitive.Empty className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
					No emoji found
				</EmojiPickerPrimitive.Empty>
				<EmojiPickerPrimitive.List className="select-none pb-1.5" components={LIST_PARTS} />
			</EmojiPickerPrimitive.Viewport>
			<div className="flex h-10 items-center gap-2 border-border-strong border-t px-2.5">
				<EmojiPickerPrimitive.ActiveEmoji>
					{({ emoji }) =>
						emoji ? (
							<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
								<span className="text-[18px]">{emoji.emoji}</span>
								<span className="truncate">{emoji.label}</span>
							</span>
						) : (
							<span className="text-subtle-foreground text-sm">Pick an emoji…</span>
						)
					}
				</EmojiPickerPrimitive.ActiveEmoji>
				<EmojiPickerPrimitive.SkinToneSelector
					aria-label="Change skin tone"
					className="focus-ring ml-auto flex size-7 shrink-0 items-center justify-center rounded-tail text-[16px] hover:bg-chip"
				/>
			</div>
		</EmojiPickerPrimitive.Root>
	);
}

const CATEGORY_HEADER = "px-3 pt-2 pb-1 font-semibold text-subtle-foreground text-xs";

const EMOJI_BUTTON = "flex size-8 items-center justify-center rounded-tail text-[20px]";

/**
 * How the grid's headers, rows and emoji are drawn. Kept here rather than in
 * the picker, so each render of it, as on every keystroke in the search, hands
 * the list the same components and it does not draw every row afresh.
 */
const LIST_PARTS: EmojiPickerListComponents = {
	CategoryHeader: ({ category, ...props }) => (
		<div className={cn(CATEGORY_HEADER, "bg-panel")} {...props}>
			{category.label}
		</div>
	),
	Row: ({ children, ...props }) => (
		<div className="scroll-my-1.5 px-1.5" {...props}>
			{children}
		</div>
	),
	Emoji: ({ emoji, ...props }) => (
		<button type="button" className={cn(EMOJI_BUTTON, emoji.isActive && "bg-chip")} {...props}>
			{emoji.emoji}
		</button>
	),
};

const DATA_OPTIONS = { resolveEmojiData };

/** A recent emoji named as the picker names it, as in "Party popper", once its names have loaded. */
function NamedRecentEmoji({
	emoji,
	onChoose,
}: {
	emoji: string;
	onChoose: (emoji: string) => void;
}) {
	const label = useEmojiDetails(emoji, DATA_OPTIONS)?.label ?? emoji;
	return <RecentEmoji emoji={emoji} label={label} onChoose={onChoose} />;
}

function RecentEmoji({
	emoji,
	label,
	onChoose,
}: {
	emoji: string;
	label: string;
	onChoose: (emoji: string) => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={() => onChoose(emoji)}
			className={cn(EMOJI_BUTTON, "focus-ring hover:bg-chip")}
		>
			{emoji}
		</button>
	);
}
