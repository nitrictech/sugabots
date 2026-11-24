import {
	holdsSuggestion,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	SUGGESTED_MODIFICATION,
	type SuggestionBy,
	suggestionBy,
} from "@sugabots/contracts/live-document";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { ArrowDown, ArrowUp, Ellipsis, PenLine, Plus, Sparkles, Trash2 } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef } from "react";
import { proposedChangeOf } from "@/lib/deck.ts";
import { pendingSuggestions } from "@/lib/suggestions.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { LayoutPicker } from "./LayoutPicker.tsx";
import { Face, type Other } from "./live-editor.tsx";
import { SlideDrawing } from "./slide-drawing.tsx";

/**
 * A deck's slides in order, each drawn small from the deck as it is now, with
 * the one on the stage ringed: a column beside the stage, or a row under it
 * on a phone. Each says who else is on it, and whether a suggestion waits in
 * it, and has a menu to move it or delete it. A new slide is added after the
 * one on the stage.
 */
export function SlideStrip({
	slides,
	current,
	others,
	serializer,
	editable,
	onSelect,
	onAdd,
	onMove,
	onRemove,
}: {
	slides: readonly Node[];
	/** The index of the slide on the stage. */
	current: number;
	others: readonly Other[];
	serializer: DOMSerializer;
	/** Whether the deck can be changed here, which it can't once its editor has stopped. */
	editable: boolean;
	onSelect: (index: number) => void;
	onAdd: (layout: SlideLayout) => void;
	onMove: (index: number, by: -1 | 1) => void;
	onRemove: (index: number) => void;
}) {
	const shown = useRef<HTMLLIElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the slide on the stage is brought into view whenever it changes.
	useEffect(() => {
		shown.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [current]);
	return (
		<nav
			aria-label="Slides"
			className="flex w-48 shrink-0 flex-col gap-2.5 overflow-y-auto pt-4 pr-3 pb-6 pl-4 max-md:w-auto max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-border max-md:border-t max-md:bg-background max-md:px-4 max-md:pt-3 max-md:pb-5"
		>
			{editable && (
				<LayoutPicker
					heading="New slide"
					onPick={onAdd}
					className="focus-ring ml-5.5 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-sm border border-border-strong bg-chip px-2.5 font-medium text-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover max-md:hidden"
				>
					<Plus aria-hidden size={14} />
					New slide
				</LayoutPicker>
			)}
			<ol className="m-0 flex list-none flex-col gap-2.5 p-0 max-md:flex-row">
				{slides.map((slide, index) => (
					<Thumbnail
						// A slide has no lasting id, so its place is its key; its drawing redraws only when it changes.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={index}
						ref={index === current ? shown : undefined}
						slide={slide}
						index={index}
						count={slides.length}
						current={index === current}
						others={others.filter((other) => other.slide === index)}
						serializer={serializer}
						editable={editable}
						onSelect={onSelect}
						onMove={onMove}
						onRemove={onRemove}
					/>
				))}
			</ol>
			{editable && (
				<LayoutPicker
					heading="New slide"
					label="New slide"
					onPick={onAdd}
					className="focus-ring grid size-16 shrink-0 place-items-center rounded-md border border-border-strong bg-chip text-foreground transition-colors hover:bg-hover data-popup-open:bg-hover md:hidden"
				>
					<Plus aria-hidden size={18} />
				</LayoutPicker>
			)}
		</nav>
	);
}

/** One slide in the strip. */
function Thumbnail({
	ref,
	slide,
	index,
	count,
	current,
	others,
	serializer,
	editable,
	onSelect,
	onMove,
	onRemove,
}: {
	ref?: Ref<HTMLLIElement>;
	slide: Node;
	index: number;
	count: number;
	current: boolean;
	others: readonly Other[];
	serializer: DOMSerializer;
	editable: boolean;
	onSelect: (index: number) => void;
	onMove: (index: number, by: -1 | 1) => void;
	onRemove: (index: number) => void;
}) {
	const proposed = proposedChangeOf(slide);
	const suggester = useMemo(() => suggesterOn(slide), [slide]);
	const number = index + 1;
	return (
		<li ref={ref} className="flex gap-2 max-md:w-28 max-md:flex-none">
			<span
				aria-hidden
				className={cn(
					"w-3.5 shrink-0 pt-0.5 text-right text-xs tabular-nums max-md:hidden",
					current ? "text-foreground" : "text-subtle-foreground",
				)}
			>
				{number}
			</span>
			<div
				className={cn(
					"group relative min-w-0 flex-1 rounded-md",
					current ? "ring-2 ring-slide-accent" : "ring-1 ring-border-strong",
					proposed === "adding" && "outline-2 outline-suggestion outline-offset-2 outline-dashed",
					proposed === "removing" && "opacity-50",
				)}
			>
				<SlideDrawing slide={slide} serializer={serializer} hidden className="rounded-md" />
				<button
					type="button"
					aria-label={`Slide ${number}${PROPOSED_WORDS[proposed ?? "none"]}: ${titleOf(slide)}`}
					aria-current={current ? "true" : undefined}
					onClick={() => onSelect(index)}
					className="focus-ring absolute inset-0 cursor-pointer rounded-md"
				/>
				{(others.length > 0 || suggester) && (
					<div className="pointer-events-none absolute top-1 right-1 flex items-center gap-1">
						{others.map(({ clientId, participant }) => (
							<Tooltip key={clientId} label={`${participant.name} is on this slide`}>
								<Face
									participant={participant}
									size={THUMBNAIL_FACE_PX}
									aria-label={`${participant.name} is on this slide`}
									className="pointer-events-auto"
								/>
							</Tooltip>
						))}
						{suggester && (
							<span
								role="img"
								aria-label={`${suggester.name} has a suggestion on this slide`}
								className="grid size-4 place-items-center rounded-full bg-panel text-suggestion ring-1 ring-suggestion/40"
							>
								{suggester.kind === "agent" ? (
									<Sparkles aria-hidden size={10} />
								) : (
									<PenLine aria-hidden size={10} />
								)}
							</span>
						)}
					</div>
				)}
				{editable && (
					<SlideMenu
						number={number}
						first={index === 0}
						last={index === count - 1}
						only={count <= 1}
						onMove={(by) => onMove(index, by)}
						onRemove={() => onRemove(index)}
					/>
				)}
			</div>
		</li>
	);
}

/** Who made a suggestion waiting on the slide or in it, if one does: the first there. */
function suggesterOn(slide: Node): SuggestionBy | undefined {
	if (!holdsSuggestion(slide)) return undefined;
	const own = slide.marks.find(
		(mark) => mark.attrs.id !== undefined && mark.type.name in SUGGESTION_NAMES,
	);
	return own ? suggestionBy(own.attrs.id) : pendingSuggestions(slide)[0]?.by;
}

const SUGGESTION_NAMES = {
	[SUGGESTED_INSERTION]: true,
	[SUGGESTED_DELETION]: true,
	[SUGGESTED_MODIFICATION]: true,
};

const PROPOSED_WORDS = { adding: ", proposed", removing: ", proposed for removal", none: "" };

const THUMBNAIL_FACE_PX = 14;

/** What a slide is called in the strip: the words of its first line, or "Untitled" while it has none. */
function titleOf(slide: Node): string {
	let title = "";
	slide.child(0).descendants((node) => {
		if (title === "" && node.isTextblock) title = node.textContent.trim();
		return title === "";
	});
	return title || "Untitled";
}

/** Moving a slide in the deck, or deleting it, from a ⋯ on its thumbnail. */
function SlideMenu({
	number,
	first,
	last,
	only,
	onMove,
	onRemove,
}: {
	number: number;
	first: boolean;
	last: boolean;
	/** Whether it is the deck's only slide, which a deck can't be without. */
	only: boolean;
	onMove: (by: -1 | 1) => void;
	onRemove: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`More for slide ${number}`}
				className="focus-ring absolute right-1 bottom-1 grid size-5 place-items-center rounded-full bg-panel text-soft-foreground opacity-0 ring-1 ring-border-strong transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 max-md:opacity-100"
			>
				<Ellipsis aria-hidden size={12} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem disabled={first} onClick={() => onMove(-1)}>
					<ArrowUp aria-hidden />
					Move up
				</DropdownMenuItem>
				<DropdownMenuItem disabled={last} onClick={() => onMove(1)}>
					<ArrowDown aria-hidden />
					Move down
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" disabled={only} onClick={onRemove}>
					<Trash2 aria-hidden />
					Delete slide
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
