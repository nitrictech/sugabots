import { SLIDE_BODY, SLIDE_COLUMN } from "@sugabots/contracts/live-slides";
import type { NestedOptions } from "@tiptap/extension-drag-handle";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { type Editor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import {
	Code,
	GripVertical,
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	type LucideIcon,
	Minus,
	Plus,
	Sparkles,
	TextQuote,
	Type,
} from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * What a block of the document can be, in the order the menus list them:
 * plain text first. `typed` is what makes the block when typed at the start
 * of a line, which the menus show beside its name.
 */
export const BLOCK_KINDS = [
	{ kind: "text", label: "Text", Icon: Type, typed: undefined },
	{ kind: "heading1", label: "Heading 1", Icon: Heading1, typed: "#" },
	{ kind: "heading2", label: "Heading 2", Icon: Heading2, typed: "##" },
	{ kind: "heading3", label: "Heading 3", Icon: Heading3, typed: "###" },
	{ kind: "bulleted", label: "Bulleted list", Icon: List, typed: "-" },
	{ kind: "numbered", label: "Numbered list", Icon: ListOrdered, typed: "1." },
	{ kind: "quote", label: "Quote", Icon: TextQuote, typed: ">" },
	{ kind: "code", label: "Code", Icon: Code, typed: "```" },
] as const satisfies readonly BlockChoice[];

interface BlockChoice {
	kind: string;
	label: string;
	Icon: LucideIcon;
	typed: string | undefined;
}

export type BlockKind = (typeof BLOCK_KINDS)[number]["kind"];

/** A line across the page: something to add, not something a block of text can be turned into. */
const DIVIDER = { kind: "divider", label: "Divider", Icon: Minus, typed: "---" } as const;

const HEADING_LEVELS = { heading1: 1, heading2: 2, heading3: 3 } as const;

/** A stretch of the document, by position. */
export interface Range {
	from: number;
	to: number;
}

/** The kind of block the selection is in. */
export function blockKindAt(editor: Editor): BlockKind {
	if (editor.isActive("bulletList")) return "bulleted";
	if (editor.isActive("orderedList")) return "numbered";
	if (editor.isActive("blockquote")) return "quote";
	if (editor.isActive("codeBlock")) return "code";
	if (editor.isActive("heading", { level: 1 })) return "heading1";
	if (editor.isActive("heading", { level: 2 })) return "heading2";
	if (editor.isActive("heading", { level: 3 })) return "heading3";
	return "text";
}

/** Makes the block the selection is in a `kind`, first removing `typed`: the "/" and search that chose it. */
export function turnInto(editor: Editor, kind: BlockKind | "divider", typed?: Range): boolean {
	const focused = editor.chain().focus();
	const cleared = typed ? focused.deleteRange(typed) : focused;
	if (kind === "divider") return cleared.setHorizontalRule().run();
	// Back to plain paragraphs first, so a list item becomes a heading and not a heading in a list.
	const plain = cleared.clearNodes();
	if (kind === "text") return plain.run();
	if (kind === "bulleted") return plain.toggleBulletList().run();
	if (kind === "numbered") return plain.toggleOrderedList().run();
	if (kind === "quote") return plain.setBlockquote().run();
	if (kind === "code") return plain.setCodeBlock().run();
	return plain.setHeading({ level: HEADING_LEVELS[kind] }).run();
}

/** A block's icon in a bordered square, as the menus of blocks draw it. */
export function BlockIcon({ Icon }: { Icon: LucideIcon }) {
	return (
		<span className="grid size-5.5 shrink-0 place-items-center rounded-xs border border-border-strong text-soft-foreground">
			<Icon aria-hidden className="size-3.5" />
		</span>
	);
}

/** What typing at the start of a line makes the block, in the type it is typed in. */
export function TypedHint({ typed }: { typed: string | undefined }) {
	if (!typed) return null;
	return <span className="font-mono text-subtle-foreground text-xs">{typed}</span>;
}

/**
 * Answers a key pressed in the text before the editor does, saying whether it
 * took it. The slash menu takes the arrows, Enter and Escape while it is open.
 */
export type TextKeys = (event: KeyboardEvent) => boolean;

/** The line the menu of blocks is open on: what on it is the search, and goes when a block is chosen. */
interface Searching extends Range {
	query: string;
}

/**
 * The search for a block on the line the caret is on, if it has one: a "/"
 * typed at its start and what follows, or anything typed on the line that
 * starts at `offeredAt`, where the menu was opened with no "/".
 */
function searching(editor: Editor, offeredAt: number | undefined): Searching | null {
	const { selection } = editor.state;
	if (!selection.empty) return null;
	const { $from } = selection;
	// On a line of the page itself and at its end: a "/" in a list or mid-sentence is only a "/".
	if (!isPageLine($from)) return null;
	if ($from.parentOffset !== $from.parent.content.size) return null;
	const offered = $from.start() === offeredAt;
	// The focus comes back to the text a moment after the press that offered the menu.
	if (!offered && !editor.isFocused) return null;
	const search = offered ? /^\/?([a-z0-9 ]*)$/i : /^\/([a-z0-9 ]*)$/i;
	const match = search.exec($from.parent.textContent);
	return match ? { from: $from.start(), to: $from.end(), query: match[1] ?? "" } : null;
}

/** What holds the lines of the page: a document itself, and a deck's slide, in its frame or a column. */
const PAGE_REGIONS = new Set(["doc", SLIDE_BODY, SLIDE_COLUMN]);

/** Whether `$from` is in a paragraph of the page's own, not one inside a list, a quote or a cell. */
const isPageLine = ($from: ResolvedPos) =>
	$from.depth >= 1 &&
	$from.parent.type.name === "paragraph" &&
	PAGE_REGIONS.has($from.node($from.depth - 1).type.name);

/**
 * The blocks a line can become, floating under it and narrowed by what is
 * typed. It opens for a "/" typed at the start of a line, and on the line at
 * `offeredAt` with nothing typed, as the + beside a block asks for. The arrows
 * and Enter choose one while the caret stays in the text, and Escape leaves
 * the line as typed.
 */
export function SlashMenu({
	editor,
	page,
	keys,
	offeredAt,
	onOfferEnd,
	writeWith,
}: {
	editor: Editor;
	/** The scrolling page the menu is placed in. */
	page: RefObject<HTMLDivElement | null>;
	/** Where the menu puts its answer to keys, for the editor to ask first. */
	keys: RefObject<TextKeys | undefined>;
	/** Where the line the menu was opened on starts, when it was opened without a "/". */
	offeredAt: number | undefined;
	/** The menu opened without a "/" has closed, by a choice, Escape or the person going elsewhere. */
	onOfferEnd: () => void;
	/** Starts asking a bot to write on the line, once its search is gone. Without it, there is no bot to ask. */
	writeWith: { onStart: () => void } | undefined;
}) {
	const typed = useEditorState({
		editor,
		selector: ({ editor: current }) => searching(current, offeredAt),
		equalityFn: (before, after) =>
			before?.from === after?.from && before?.to === after?.to && before?.query === after?.query,
	});
	// Escape closes the menu for the line it was opened on, until the search there is gone.
	const [closedAt, setClosedAt] = useState<number>();
	useEffect(() => {
		if (!typed) setClosedAt(undefined);
	}, [typed]);
	const query = typed?.query.trim().toLowerCase() ?? "";
	const choices = [
		...(writeWith
			? [
					{
						key: "write",
						label: "Write with bot",
						Icon: Sparkles,
						typed: undefined,
						choose: (at: Range) => {
							editor.chain().focus().deleteRange(at).run();
							writeWith.onStart();
						},
					},
				]
			: []),
		// A deck has no divider: a slide holds no line across it.
		...[...BLOCK_KINDS, ...(editor.schema.nodes.horizontalRule ? [DIVIDER] : [])].map(
			({ kind, ...shown }) => ({
				key: kind,
				...shown,
				choose: (at: Range) => void turnInto(editor, kind, at),
			}),
		),
	].filter(({ label }) => label.toLowerCase().includes(query));
	const open = typed !== null && typed.from !== closedAt && choices.length > 0;
	/** Makes the choice, which ends an offer: asking a bot takes this menu away before it could see itself close. */
	function pick(choice: { choose: (at: Range) => void } | undefined, at: Range) {
		if (!choice) return;
		choice.choose(at);
		onOfferEnd();
	}
	// An offer lasts until its menu closes, so the line is ordinary text from then on.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (open) wasOpen.current = true;
		else if (wasOpen.current) {
			wasOpen.current = false;
			onOfferEnd();
		}
	});
	useEffect(() => {
		if (offeredAt === undefined) return;
		editor.on("blur", onOfferEnd);
		return () => {
			editor.off("blur", onOfferEnd);
		};
	}, [editor, offeredAt, onOfferEnd]);

	const [lit, setLit] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new search starts from its first match.
	useEffect(() => setLit(0), [query]);
	const [at, setAt] = useState<{ top: number; left: number }>();
	const from = typed?.from;
	useLayoutEffect(() => {
		const element = page.current;
		if (from === undefined || !element) return setAt(undefined);
		const frame = element.getBoundingClientRect();
		const line = editor.view.coordsAtPos(from);
		setAt({
			top: line.bottom - frame.top + element.scrollTop + SLASH_MENU_GAP_PX,
			left: line.left - frame.left,
		});
	}, [editor, page, from]);

	useEffect(() => {
		if (!open || !typed) return;
		keys.current = (event) => {
			if (event.key === "ArrowDown") setLit((lit + 1) % choices.length);
			else if (event.key === "ArrowUp") setLit((lit - 1 + choices.length) % choices.length);
			else if (event.key === "Enter") pick(choices[lit], typed);
			else if (event.key === "Escape") setClosedAt(typed.from);
			else return false;
			return true;
		};
		return () => {
			keys.current = undefined;
		};
	});

	if (!open || !typed || !at) return null;
	return (
		<div
			role="listbox"
			aria-label="Blocks"
			style={at}
			// Keeps the caret in the text, which a press anywhere else would take.
			onMouseDown={(event) => event.preventDefault()}
			className="absolute z-10 flex max-h-80 w-72 flex-col gap-px overflow-y-auto rounded-lg border border-border-strong bg-panel p-1 shadow-popover"
		>
			{choices.map(({ key, label, Icon, typed: hint, choose }, index) => (
				<button
					key={key}
					type="button"
					role="option"
					aria-selected={index === lit}
					ref={index === lit ? showInMenu : undefined}
					onMouseEnter={() => setLit(index)}
					onClick={() => pick({ choose }, typed)}
					className={cn(
						"flex h-8 shrink-0 items-center gap-2.5 rounded-tail px-2 text-left text-foreground text-xs",
						index === lit && "bg-chip",
						key === "write" && "font-medium text-suggestion",
					)}
				>
					{key === "write" ? (
						<span className="grid size-5.5 shrink-0 place-items-center">
							<Icon aria-hidden className="size-3.5" />
						</span>
					) : (
						<BlockIcon Icon={Icon} />
					)}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					<TypedHint typed={hint} />
				</button>
			))}
		</div>
	);
}

/** Scrolls the menu, not the page, to the choice the arrows have reached. */
const showInMenu = (choice: HTMLButtonElement | null) =>
	choice?.scrollIntoView({ block: "nearest" });

/** The space between the line the menu is open on and the menu under it. */
const SLASH_MENU_GAP_PX = 6;

/**
 * What shows beside the block the pointer is over, or level with in the
 * margin: a + that starts a new block under it, with the menu of blocks open,
 * and a grip to drag the block somewhere else on the page.
 */
export function BlockHandle({
	editor,
	onOffer,
	nested,
}: {
	editor: Editor;
	/** Opens the menu of blocks on the empty line that starts at `at`. */
	onOffer: (at: number) => void;
	/** Which blocks inside others it shows beside, where the page's blocks hold blocks. Without, only the page's own. */
	nested?: NestedOptions;
}) {
	const over = useRef<{ node: Node; pos: number }>(null);
	function addBelow() {
		if (!over.current) return;
		const { node, pos } = over.current;
		// An empty line is already the new block.
		const empty = node.type.name === "paragraph" && node.content.size === 0;
		const line = empty ? pos : pos + node.nodeSize;
		const focused = editor.chain().focus();
		const added = empty ? focused : focused.insertContentAt(line, { type: "paragraph" });
		added.setTextSelection(line + 1).run();
		onOffer(line + 1);
	}
	return (
		<DragHandle
			editor={editor}
			nested={nested}
			onNodeChange={({ node, pos }) => {
				over.current = node && pos >= 0 ? { node, pos } : null;
			}}
			className="flex items-center gap-0.5 pr-1.5 max-md:hidden"
		>
			<IconButton
				label="Add a block below"
				side="top"
				onClick={addBelow}
				className="size-7 [&_svg]:size-4"
			>
				<Plus aria-hidden />
			</IconButton>
			<Tooltip side="top" label="Drag to move">
				<span className="grid h-7 w-5.5 cursor-grab place-items-center rounded-md text-subtle-foreground transition-colors hover:bg-hover hover:text-foreground">
					<GripVertical aria-hidden className="size-4" />
				</span>
			</Tooltip>
		</DragHandle>
	);
}
