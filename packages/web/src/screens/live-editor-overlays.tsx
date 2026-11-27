import type { HocuspocusProvider } from "@hocuspocus/provider";
import { type EditRequest, LIVE_DOCUMENT_EDIT_REQUESTS } from "@sugabots/contracts/live-document";
import { SLIDE, SLIDE_BOX, SPEAKER_NOTES } from "@sugabots/contracts/live-slides";
import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import { Effect } from "effect";
import {
	ArrowUp,
	Bold,
	Check,
	ChevronDown,
	Italic,
	Link2,
	type LucideIcon,
	PenLine,
	Sparkles,
	Strikethrough,
	Underline,
	X,
} from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { LAYOUT_NAMES } from "@/lib/deck.ts";
import type { DesignChanges, PendingSuggestion } from "@/lib/suggestions.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { FloatingMenu, MENU_GAP_PX, MenuDivider } from "./floating-menu.tsx";
import {
	BLOCK_KINDS,
	BlockHandle,
	BlockIcon,
	blockKindAt,
	type Range,
	SlashMenu,
	type TextKeys,
	TypedHint,
	turnInto,
} from "./LiveDocumentBlocks.tsx";
import { LinkBox } from "./live-document-text.tsx";
import { editTarget } from "./live-editor.tsx";

/*
 * What floats over a live editor's text, the same in a document and in a
 * deck: the menu of blocks, the menu for selected text, asking a bot for an
 * edit and waiting on it, and the card a suggestion is settled from; and on
 * a document's page, the handle beside a block.
 */

/** The bot a person asks for an edit. */
export interface AskedBot {
	agentId: string;
	name: string;
}

/**
 * The text a request is about, with where it sits in the document, for the
 * bot to find it by. A request made on an empty line is about no text: it
 * asks for something to be written there.
 */
interface AskedAbout {
	/** The words the person selected, or none on an empty line. */
	selected: string;
	/** The whole of the paragraphs those words are in. */
	passage: string;
	/** The nearest heading above them, if the document has one there, or the slide does in a deck. */
	heading: string | undefined;
	/** The block before theirs, if there is one: where new writing goes after. */
	before: string | undefined;
	/** In a deck, the slide they are on, by its number from 1. */
	slide?: number;
}

/** What a person asked for, and the text it is about. */
export interface Asked extends AskedAbout {
	instruction: string;
}

/** The box open for an instruction: what it is about, and where on the page it sits. */
export interface Asking extends AskedAbout {
	top: number;
	left: number;
}

/**
 * What floats over the text on `page`, the element that scrolls it. While
 * `asking` is set the box for asking `bot` for an edit is open; the editor
 * holds it, as the text makes way for it.
 */
export function EditorOverlays({
	editor,
	provider,
	page,
	slashKeys,
	editable,
	bot,
	onAsk,
	asking,
	onAskingChange,
	blockHandle,
}: {
	editor: Editor;
	provider: HocuspocusProvider;
	page: RefObject<HTMLDivElement | null>;
	/** Where the menu of blocks puts its answer to keys, for the editor to ask first. */
	slashKeys: RefObject<TextKeys | undefined>;
	/** Whether the text can be edited here, which it can't once the editor has stopped. */
	editable: boolean;
	/** The bot people here can ask for edits, if there is one. */
	bot: AskedBot | undefined;
	/** Asks `bot` for the edit, answering the id of the thread the bot will work in. */
	onAsk: (bot: AskedBot, asked: Asked) => Promise<string>;
	asking: Asking | undefined;
	onAskingChange: (asking: Asking | undefined) => void;
	/**
	 * Whether a handle beside each block drags it elsewhere, and adds a block
	 * under it: on a document's page, but not on a deck's slide, where its box
	 * is what a person drags, and a second thing to drag beside it confuses.
	 */
	blockHandle: boolean;
}) {
	const requests = useEditRequests(provider);
	const [awaited, setAwaited] = useState<Awaited[]>([]);
	// The mark on the text asked about goes once nothing is being asked or waited for.
	const stillWaiting = awaited.some(({ threadId }) =>
		requests.waiting.some((request) => request.threadId === threadId),
	);
	useEffect(() => {
		if (asking || stillWaiting) return;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, null));
	}, [editor, asking, stillWaiting]);
	const [menuHeld, setMenuHeld] = useState(false);
	// Where the line starts that the + beside a block opened the menu of blocks on.
	const [blocksOfferedAt, setBlocksOfferedAt] = useState<number>();
	const endBlocksOffer = useCallback(() => setBlocksOfferedAt(undefined), []);
	const offer = useSelectionMenu(editor, page, {
		offered: asking === undefined,
		held: menuHeld,
	});
	/** Opens the box under the selected text, which stays marked while the box is open. */
	function startAsking() {
		if (!offer) return;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, offer.selected));
		// Under the start of the selection, moved left where it would run off the page.
		const roomAcross = (page.current?.clientWidth ?? 0) - ASK_BOX_WIDTH_PX - ASK_BOX_MARGIN_PX;
		onAskingChange({
			...askedAbout(editor.state.doc, offer.selected),
			top: offer.below,
			left: Math.max(ASK_BOX_MARGIN_PX, Math.min(offer.left, roomAcross)),
		});
	}
	/** Opens the box under the empty line the caret is on, for something to be written there. */
	function startAskingToWrite() {
		const element = page.current;
		if (!element) return;
		const { from } = editor.state.selection;
		const pageArea = element.getBoundingClientRect();
		const line = editor.view.coordsAtPos(from);
		const roomAcross = element.clientWidth - ASK_BOX_WIDTH_PX - ASK_BOX_MARGIN_PX;
		onAskingChange({
			...askedAbout(editor.state.doc, { from, to: from }),
			top: line.bottom - pageArea.top + element.scrollTop + EDIT_OFFER_GAP_PX,
			left: Math.max(ASK_BOX_MARGIN_PX, Math.min(line.left - pageArea.left, roomAcross)),
		});
	}
	function stopAsking() {
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, null));
		onAskingChange(undefined);
	}
	async function ask(bot: AskedBot, instruction: string) {
		if (!asking) return;
		const threadId = await onAsk(bot, { ...asking, instruction });
		requests.add(threadId, { instruction, agent: bot.name, answered: false });
		// The text stays marked, with a note under it, until the bot's suggestion takes its place.
		setAwaited((awaited) => [...awaited, { threadId, top: asking.top, left: asking.left }]);
		onAskingChange(undefined);
	}
	const waiting = awaited.flatMap((at) => {
		const request = requests.waiting.find(({ threadId }) => threadId === at.threadId);
		return request ? [{ ...at, agent: request.agent }] : [];
	});
	return (
		<>
			{editable && blockHandle && <BlockHandle editor={editor} onOffer={setBlocksOfferedAt} />}
			{!asking && editable && (
				<SlashMenu
					editor={editor}
					page={page}
					keys={slashKeys}
					offeredAt={blocksOfferedAt}
					onOfferEnd={endBlocksOffer}
					writeWith={bot ? { onStart: startAskingToWrite } : undefined}
				/>
			)}
			{offer && (
				<SelectionMenu
					editor={editor}
					at={offer.menu}
					editWith={bot ? { name: bot.name, onStart: startAsking } : undefined}
					onHold={setMenuHeld}
				/>
			)}
			{asking && bot && (
				<AskBox
					at={asking}
					bot={bot}
					writing={asking.selected === ""}
					onAsk={(instruction) => ask(bot, instruction)}
					onCancel={() => {
						stopAsking();
						editor.commands.focus();
					}}
					onClickAway={stopAsking}
				/>
			)}
			{waiting.map((request) => (
				<UnderText key={request.threadId} at={request} label={`${request.agent} is working`}>
					<Sparkles aria-hidden size={13} className="ml-1.5 animate-pulse text-suggestion" />
					<span className="px-1 text-soft-foreground text-xs">{request.agent} is working</span>
					<IconButton label="Stop waiting" onClick={() => requests.dismiss(request.threadId)}>
						<X aria-hidden />
					</IconButton>
				</UnderText>
			))}
		</>
	);
}

/** Something about a stretch of the text, floating just under it: what a bot is doing there, or what to do with its suggestion. */
function UnderText({
	at,
	label,
	children,
}: {
	at: { top: number; left: number };
	label: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for.
		<div
			role="group"
			aria-label={label}
			style={at}
			className="absolute z-10 flex items-center gap-0.5 rounded-full border border-border-strong bg-panel p-1 shadow-popover"
		>
			{children}
		</div>
	);
}

/**
 * A suggestion said in words, with undoing or accepting it: a `card` for the
 * margin beside the text, or a `bar` as wide as the text, which says whose
 * the suggestion is in its sentence. Where it goes is for its editor to say.
 */
export function SuggestionCard({
	suggestion,
	shape,
	onAccept,
	onUndo,
}: {
	suggestion: PendingSuggestion;
	shape: "card" | "bar";
	onAccept: () => void;
	onUndo: () => void;
}) {
	const mark = (
		<span className="grid size-7 shrink-0 place-items-center rounded-full bg-suggestion/15 text-suggestion">
			{suggestion.by.kind === "agent" ? (
				<Sparkles aria-hidden size={14} />
			) : (
				<PenLine aria-hidden size={14} />
			)}
		</span>
	);
	const settle = (
		<>
			<button
				type="button"
				onClick={onUndo}
				className="focus-ring h-7 shrink-0 rounded-full border border-border-strong px-3 text-soft-foreground text-xs transition-colors hover:bg-hover"
			>
				Undo
			</button>
			<button
				type="button"
				onClick={onAccept}
				className="focus-ring h-7 shrink-0 rounded-full bg-suggestion px-3 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
			>
				Accept
			</button>
		</>
	);
	const label = `Suggestion from ${suggestion.by.name}`;
	if (shape === "card") {
		return (
			// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for.
			<div
				role="group"
				aria-label={label}
				className="flex w-66 flex-col gap-2 rounded-xl border border-border-strong bg-panel p-3"
			>
				<div className="flex items-center gap-2">
					{mark}
					<span className="min-w-0 truncate font-medium text-foreground text-xs">
						{suggestion.by.name}
					</span>
				</div>
				<p className="m-0 line-clamp-2 text-soft-foreground text-xs">{changeInWords(suggestion)}</p>
				<div className="flex justify-end gap-2">{settle}</div>
			</div>
		);
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend this has no use for.
		<div
			role="group"
			aria-label={label}
			className="flex items-center gap-2.5 rounded-xl border border-border-strong bg-panel py-2 pr-2 pl-2.5 shadow-popover"
		>
			{mark}
			<span className="min-w-0 flex-1 truncate text-soft-foreground text-xs">
				<span className="font-medium text-foreground">{suggestion.by.name}</span>{" "}
				{lowerFirst(changeInWords(suggestion))}
			</span>
			{settle}
		</div>
	);
}

/**
 * What a suggestion would do, as sentences that follow whose it is: what it
 * does to a slide, or else to words and to how a deck looks. A new layout
 * moves, adds and removes a slide's boxes, which go without saying.
 */
function changeInWords({ removes, adds, slides, design }: PendingSuggestion): string {
	if (slides?.adds && slides.removes) return "Moved a slide.";
	if (slides?.adds) return "Added a slide.";
	if (slides?.removes) return "Removed this slide.";
	if (slides?.layout) return `Changed the layout to ${LAYOUT_NAMES[slides.layout]}.`;
	const sentences = [wordsChangeInWords(removes, adds), design && designChangeInWords(design)];
	const said = sentences.filter((sentence) => typeof sentence === "string" && sentence !== "");
	return said.length > 0 ? said.join(" ") : "Changed the formatting.";
}

/** What a suggestion would do to words, as a sentence: `undefined` when it adds and removes none. */
function wordsChangeInWords(removes: string, adds: string): string | undefined {
	if (removes && adds) return `Changed “${removes}” to “${adds}”.`;
	if (adds) return `Added “${adds}”.`;
	if (removes) return `Removed “${removes}”.`;
	return undefined;
}

/**
 * What a suggestion would change of how a deck looks, as a sentence, such
 * as "Moved and restyled a box and changed a slide's background.".
 */
function designChangeInWords({ boxes, background, lines }: DesignChanges): string | undefined {
	const boxCounts = new Map<string, number>();
	for (const box of boxes) {
		const verbs = [
			box.moved && "moved",
			box.resized && "resized",
			box.restyled && "restyled",
		].filter((verb) => typeof verb === "string");
		const done = listInWords(verbs);
		if (done) boxCounts.set(done, (boxCounts.get(done) ?? 0) + 1);
	}
	const changes = [
		...[...boxCounts].map(([done, count]) => `${done} ${count === 1 ? "a box" : `${count} boxes`}`),
		...(background ? ["changed a slide's background"] : []),
		...(lines ? ["changed how text is aligned or spaced"] : []),
	];
	const sentence = listInWords(changes);
	return sentence && `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** `items` as a list in words: "a", "a and b", "a, b and c". */
function listInWords(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const lowerFirst = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1);

/** An edit this person asked for and is waiting on, and where on the page its note sits. */
interface Awaited {
	threadId: string;
	top: number;
	left: number;
}

/**
 * What can be done to the selected text, floating just above it: asking a
 * bot to change it, and formatting it. Nothing shows until text is selected,
 * so the page stays clear while the person writes.
 */
function SelectionMenu({
	editor,
	at,
	editWith,
	onHold,
}: {
	editor: Editor;
	/** Where in the window the menu's bottom left corner goes. */
	at: { top: number; left: number };
	/** The bot that can be asked to change the selected text, and how to start asking it. Without it, there is none. */
	editWith: { name: string; onStart: () => void } | undefined;
	/**
	 * Told to keep the menu up while the person is in a part of it that takes
	 * the focus from the text: the dropdown of kinds, or the box for a link.
	 */
	onHold: (held: boolean) => void;
}) {
	const [linking, setLinking] = useState(false);
	/** The selected text stays marked while the link is typed, when the selection itself is in the box. */
	function startLinking() {
		const { from, to } = editor.state.selection;
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, { from, to }));
		onHold(true);
		setLinking(true);
	}
	function stopLinking() {
		editor.view.dispatch(editor.state.tr.setMeta(editTarget, null));
		setLinking(false);
		onHold(false);
		editor.commands.focus();
	}
	/** Links the selected text to `address`, or unlinks it with none. */
	function link(address: string | undefined) {
		const selected = editor.chain().focus().extendMarkRange("link");
		(address ? selected.setLink({ href: address }) : selected.unsetLink()).run();
	}
	const linkedTo: unknown = editor.getAttributes("link").href;

	// Starts over the selection's first word.
	return (
		<FloatingMenu at={at} label="Selected text">
			{linking ? (
				<LinkBox
					address={typeof linkedTo === "string" ? linkedTo : ""}
					onApply={link}
					onDone={stopLinking}
				/>
			) : (
				<>
					{editWith && (
						<>
							<Tooltip side="top" label={`Ask ${editWith.name}`}>
								<button
									type="button"
									onClick={editWith.onStart}
									className="focus-ring flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-suggestion text-xs transition-colors hover:bg-hover"
								>
									<Sparkles aria-hidden size={13} />
									Edit with bot
								</button>
							</Tooltip>
							<MenuDivider />
						</>
					)}
					<BlockKindPicker editor={editor} onOpenChange={onHold} />
					<MenuDivider />
					<FormatButton editor={editor} label="Bold" Icon={Bold} mark="bold" />
					<FormatButton editor={editor} label="Italic" Icon={Italic} mark="italic" />
					<FormatButton editor={editor} label="Underline" Icon={Underline} mark="underline" />
					<FormatButton editor={editor} label="Strikethrough" Icon={Strikethrough} mark="strike" />
					<MenuDivider />
					<LinkButton editor={editor} onClick={startLinking} />
				</>
			)}
		</FloatingMenu>
	);
}

/** Opens the box for a link, lit while the selected text is one. */
function LinkButton({ editor, onClick }: { editor: Editor; onClick: () => void }) {
	const linked = useEditorState({
		editor,
		selector: ({ editor: current }) => current.isActive("link"),
	});
	return (
		<IconButton
			label="Link"
			side="top"
			aria-pressed={linked}
			onClick={onClick}
			className={cn(linked && "bg-hover-strong text-foreground")}
		>
			<Link2 aria-hidden />
		</IconButton>
	);
}

/** Says what kind of block the selected text is, by its icon and name, and turns it into another. */
function BlockKindPicker({
	editor,
	onOpenChange,
}: {
	editor: Editor;
	onOpenChange: (open: boolean) => void;
}) {
	const current = useEditorState({
		editor,
		selector: ({ editor: now }) => blockKindAt(now),
	});
	const shown = BLOCK_KINDS.find(({ kind }) => kind === current) ?? BLOCK_KINDS[0];
	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<Tooltip side="top" label="Text style">
				<DropdownMenuTrigger
					aria-label={`Text style, now ${shown.label}`}
					className="focus-ring flex h-6 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover"
				>
					<shown.Icon aria-hidden size={14} className="text-muted-foreground" />
					{shown.label}
					<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
				</DropdownMenuTrigger>
			</Tooltip>
			<DropdownMenuContent align="start" className="min-w-56">
				<p className="m-0 px-2.5 pt-2 pb-1 text-muted-foreground text-xs">Turn into</p>
				{BLOCK_KINDS.map(({ kind, label, Icon, typed }) => (
					<DropdownMenuItem key={kind} onClick={() => turnInto(editor, kind)}>
						<BlockIcon Icon={Icon} />
						<span className="flex-1">{label}</span>
						<TypedHint typed={typed} />
						<Check aria-hidden className={kind === current ? "text-suggestion" : "invisible"} />
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A way of marking the selected text, such as bold, lit while the text is marked so. */
function FormatButton({
	editor,
	label,
	Icon,
	mark,
}: {
	editor: Editor;
	label: string;
	Icon: LucideIcon;
	mark: "bold" | "italic" | "underline" | "strike";
}) {
	const active = useEditorState({
		editor,
		selector: ({ editor: current }) => current.isActive(mark),
	});
	const toggle = () => editor.chain().focus().toggleMark(mark).run();
	return (
		<IconButton
			label={label}
			side="top"
			aria-pressed={active}
			onClick={toggle}
			className={cn(active && "bg-hover-strong text-foreground")}
		>
			<Icon aria-hidden />
		</IconButton>
	);
}

function askedAbout(document: Node, { from, to }: Range): AskedAbout {
	const [start, end] = [document.resolve(from), document.resolve(to)];
	const selected = document.textBetween(from, to, "\n");
	const passage = document.textBetween(start.start(), end.end(), "\n");
	if (SLIDE in document.type.schema.nodes) return { selected, passage, ...whereOnSlide(start) };
	let heading: string | undefined;
	document.forEach((block, offset) => {
		if (offset <= from && block.type.name === "heading") heading = block.textContent;
	});
	const blockIndex = start.index(0);
	return {
		selected,
		passage,
		heading,
		before: blockIndex > 0 ? document.child(blockIndex - 1).textContent : undefined,
	};
}

/** The parts of a slide that hold its blocks: its boxes, and its notes. */
const SLIDE_REGIONS = new Set([SLIDE_BOX, SPEAKER_NOTES]);

/**
 * Where on a deck's slide `place` is, for a bot to find it by: the slide's
 * number, the nearest heading above it on the slide, and the block before
 * its own in the part of the slide it is in.
 */
function whereOnSlide(place: ResolvedPos): Pick<AskedAbout, "heading" | "before" | "slide"> {
	let regionDepth = place.depth;
	while (regionDepth > 1 && !SLIDE_REGIONS.has(place.node(regionDepth).type.name)) regionDepth--;
	const blockIndex = place.index(regionDepth);
	const slideStart = place.start(1);
	let heading: string | undefined;
	place.node(1).descendants((node, offset) => {
		if (slideStart + offset <= place.pos && node.type.name === "heading") {
			heading = node.textContent;
		}
		return !node.isTextblock;
	});
	return {
		heading,
		before: blockIndex > 0 ? place.node(regionDepth).child(blockIndex - 1).textContent : undefined,
		slide: place.index(0) + 1,
	};
}

/** The selected text, and where on the page its menu and the box for a request go. */
interface SelectionMenuAt {
	selected: Range;
	/** Where the menu goes in the window: just above the start of the selection. */
	menu: { top: number; left: number };
	/** The bottom of the selection's last line, down the page. */
	below: number;
	/** The start of the selection, across the page. */
	left: number;
}

/**
 * Where the menu for the selected text goes, once the person has finished
 * selecting it, while `offered` is true. While `held`, it stays where it is:
 * a dropdown opened from the menu takes the focus, which would otherwise
 * read as the person having left the text.
 */
function useSelectionMenu(
	editor: Editor,
	page: RefObject<HTMLDivElement | null>,
	{ offered, held }: { offered: boolean; held: boolean },
): SelectionMenuAt | undefined {
	const selected = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			if (!current.isFocused || current.state.selection.empty) return null;
			// A block picked up by its handle is selected too, and is being moved, not formatted.
			if (!(current.state.selection instanceof TextSelection)) return null;
			const { from, to } = current.state.selection;
			return { from, to };
		},
		equalityFn: (before, after) => before?.from === after?.from && before?.to === after?.to,
	});
	// A menu that followed the pointer while it dragged out a selection would sit under it.
	// Only a press on the text counts: one on the menu itself is a click on one of its actions.
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		const text = editor.view.dom;
		const down = () => setDragging(true);
		const up = () => setDragging(false);
		text.addEventListener("pointerdown", down);
		window.addEventListener("pointerup", up);
		return () => {
			text.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
		};
	}, [editor]);
	const [offer, setOffer] = useState<SelectionMenuAt>();
	const place = useCallback(() => {
		const element = page.current;
		if (held) return;
		if (!element || !selected || dragging || !offered) return setOffer(undefined);
		const pageArea = element.getBoundingClientRect();
		const [start, end] = [
			editor.view.coordsAtPos(selected.from),
			editor.view.coordsAtPos(selected.to),
		];
		// Scrolled out of sight, the selection has nowhere to show a menu.
		if (start.top < pageArea.top || start.top > pageArea.bottom) return setOffer(undefined);
		setOffer({
			selected,
			menu: { top: start.top - MENU_GAP_PX, left: start.left },
			below: end.bottom - pageArea.top + element.scrollTop + EDIT_OFFER_GAP_PX,
			left: start.left - pageArea.left,
		});
	}, [editor, page, selected, dragging, offered, held]);
	useLayoutEffect(place, [place]);
	// The menu sits in the window, so it is placed again whenever the text moves under it.
	useEffect(() => {
		const element = page.current;
		if (!element) return;
		element.addEventListener("scroll", place);
		window.addEventListener("resize", place);
		return () => {
			element.removeEventListener("scroll", place);
			window.removeEventListener("resize", place);
		};
	}, [page, place]);
	return offer;
}

/** The space between the text and the box below it, or a suggestion's card above or below it. */
export const EDIT_OFFER_GAP_PX = 6;

/**
 * Where a person tells the bot what to change, under the text they selected,
 * or what to write, under the empty line they are on. What the bot does comes
 * back into the document as a suggestion.
 */
function AskBox({
	at,
	bot,
	writing,
	onAsk,
	onCancel,
	onClickAway,
}: {
	at: { top: number; left: number };
	bot: AskedBot;
	/** Asked from an empty line, for something to be written there, and not about selected text. */
	writing: boolean;
	onAsk: (instruction: string) => Promise<void>;
	/** The person pressed Escape in the box, and goes back to the text. */
	onCancel: () => void;
	/** The person pressed somewhere else, which is where they are now. */
	onClickAway: () => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [state, setState] = useState<"writing" | "sending" | "failed">("writing");
	const unsendable = instruction.trim() === "" || state === "sending";
	// The person clicked to open this box, so typing goes here.
	const field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => field.current?.focus(), []);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const pressed = (event: PointerEvent) => {
			if (event.target instanceof Element && !box.current?.contains(event.target)) onClickAway();
		};
		document.addEventListener("pointerdown", pressed);
		return () => document.removeEventListener("pointerdown", pressed);
	}, [onClickAway]);
	async function send() {
		if (unsendable) return;
		setState("sending");
		try {
			await onAsk(instruction.trim());
		} catch {
			setState("failed");
		}
	}
	return (
		<div
			ref={box}
			style={at}
			className="focus-ring-within absolute z-10 flex w-88 max-w-full flex-col rounded-xl border border-border-strong bg-panel shadow-popover"
		>
			<div className="flex items-end gap-2 py-1.5 pr-1.5 pl-2.5">
				<span className="grid size-7 shrink-0 place-items-center text-suggestion">
					<Sparkles aria-hidden size={14} />
				</span>
				<textarea
					ref={field}
					rows={1}
					aria-label={`What ${bot.name} should ${writing ? "write" : "change"}`}
					placeholder={`Tell ${bot.name} what to ${writing ? "write" : "change"}`}
					value={instruction}
					onChange={(event) => setInstruction(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onCancel();
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void send();
						}
					}}
					className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-foreground text-sm outline-none placeholder:text-subtle-foreground"
				/>
				<button
					type="button"
					aria-label="Send"
					disabled={unsendable}
					onClick={send}
					className="focus-ring grid size-7 shrink-0 place-items-center rounded-full bg-suggestion text-primary-foreground transition-opacity hover:opacity-90 disabled:bg-chip-strong disabled:text-disabled-foreground"
				>
					<ArrowUp aria-hidden size={15} />
				</button>
			</div>
			{state === "failed" && (
				<p role="alert" className="m-0 px-3 pb-2 text-destructive-text text-xs">
					{bot.name} could not be asked. Try again.
				</p>
			)}
		</div>
	);
}

/** How wide the box is, as its `w-88`, and the least room it keeps from the page's edge. */
const ASK_BOX_WIDTH_PX = 352;
const ASK_BOX_MARGIN_PX = 16;

/**
 * The edits people asked a bot for from inside this document, which everyone
 * in it sees. The API reads the same list to know which of a bot's changes
 * to show as suggestions.
 */
function useEditRequests(provider: HocuspocusProvider) {
	const requests = provider.document.getMap<EditRequest>(LIVE_DOCUMENT_EDIT_REQUESTS);
	const [waiting, setWaiting] = useState<(EditRequest & { threadId: string })[]>([]);
	useEffect(() => {
		const update = () =>
			setWaiting(
				[...requests.entries()]
					.filter(([, request]) => !request.answered)
					.map(([threadId, request]) => ({ threadId, ...request })),
			);
		update();
		requests.observe(update);
		return () => requests.unobserve(update);
	}, [requests]);
	return {
		waiting,
		add: (threadId: string, request: EditRequest) => void requests.set(threadId, request),
		/** Stops showing the request. The bot's change for it, if one comes, is still a suggestion. */
		dismiss: (threadId: string) => {
			const request = requests.get(threadId);
			if (request) requests.set(threadId, { ...request, answered: true });
		},
	};
}

/**
 * Asks `bot` for an edit to the document or deck by starting a thread with
 * it in the pod's chat, where the bot answers and the request stays on
 * record. Answers the thread's id.
 */
export async function askForEdit({
	workspaceId,
	podId,
	artifactId,
	title,
	bot,
	asked,
}: {
	workspaceId: string;
	podId: string;
	artifactId: string;
	title: string;
	bot: AskedBot;
	asked: Asked;
}): Promise<string> {
	const noun = asked.slide === undefined ? "document" : "deck";
	const chat = await Effect.runPromise(
		client.api.chats.openPodChat({ params: { workspace: workspaceId, podId } }),
	);
	const started = await Effect.runPromise(
		client.api.chats.startThread({
			params: { conversationId: chat.id },
			payload: {
				id: uuidv4(),
				hostAgentId: bot.agentId,
				message: [
					`Please edit the ${noun} "${title}" (artifact ${artifactId}).`,
					whereAsked(asked),
					...(asked.selected === "" ? whereToWrite(asked) : whatToChange(asked)),
					`Make the change with artifact_edit. It will be shown to me in the ${noun} as a suggestion to accept or reject.`,
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		}),
	);
	return started.conversation.id;
}

/** Where in the document or deck a request is about, as the bot reads it, if that says more than the text does. */
function whereAsked({ heading, slide }: Asked): string {
	const underHeading = heading ? `under the heading "${heading}"` : "";
	if (slide === undefined) return underHeading && `Where: ${underHeading}.`;
	return `Where: on slide ${slide}${underHeading && `, ${underHeading}`}.`;
}

/** A request about selected text, as the bot reads it. */
const whatToChange = (asked: Asked) => [
	`The text I selected:\n\n${quoted(asked.selected)}`,
	asked.passage === asked.selected ? "" : `The paragraph it is in:\n\n${quoted(asked.passage)}`,
	`What to change: ${asked.instruction}`,
];

/** A request made on an empty line, as the bot reads it: where the line is, and what to write on it. */
const whereToWrite = (asked: Asked) => [
	asked.before
		? `I am on an empty line right after this text:\n\n${quoted(asked.before)}`
		: `I am on an empty line at the start of the ${asked.slide === undefined ? "document" : "slide"}.`,
	`What to write there: ${asked.instruction}`,
];

/** Text as a markdown quote, line by line. */
const quoted = (text: string) => `> ${text.replaceAll("\n", "\n> ")}`;
