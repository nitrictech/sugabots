import { botColorVariables } from "@sugabots/avatars";
import { splitAroundMentions, type ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import {
	type ClipboardEvent,
	type FocusEvent,
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useEffectEvent,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { participantWithHandle } from "./mentions.tsx";

/*
 * A message box whose text is plain, with `@handle` for a mention, but which
 * draws each finished mention of somebody it knows as a chip: their face and
 * name, kept whole, removed with one Backspace. A mention is finished once
 * whitespace follows it, so one still being typed stays text for the mention
 * menu to complete.
 *
 * The browser edits the box; after each edit its text is read back, the
 * chips are drawn again where they changed, and the caret is put back where
 * it was in the text. Offsets are into the plain text, where a chip counts as
 * its `@handle`.
 */

export interface MentionEditorHandle {
	focus: () => void;
	/**
	 * Replaces the text from `start` to `end` with `text`, as typing it would,
	 * and focuses the box with the caret after it.
	 */
	replace: (range: TextRange, text: string) => void;
}

/** A stretch of the box's text, by offsets into it. */
export interface TextRange {
	start: number;
	end: number;
}

/** A finished mention's `@handle` in the text, and whom it names. */
type Segment = { kind: "text"; text: string } | { kind: "mention"; participant: ThreadParticipant };

/** Marks a chip, holding the `@handle` it stands for. */
const MENTION_ATTRIBUTE = "data-mention";
/** What, straight after a mention, would be read as more of its handle, or as a mention of its own. */
const RUNS_ON_INTO_MENTION = /[a-z0-9@-]/i;

/** Marks the `<br>` that gives an empty last line its height, which is not part of the text. */
const FILLER_ATTRIBUTE = "data-filler";

export function MentionEditor({
	ref,
	id,
	label,
	value,
	onValueChange,
	onCaretChange,
	mentionable,
	maxLength,
	onKeyDown,
	onPaste,
	onFocus,
	onBlur,
	className,
	...aria
}: {
	ref?: Ref<MentionEditorHandle>;
	id: string;
	/** Names the box for assistive technology, and is its placeholder. */
	label: string;
	value: string;
	/** The new text, and where the caret is in it. */
	onValueChange: (value: string, caret: number) => void;
	/** Where the caret moved to in the text, while the box has the focus. */
	onCaretChange: (caret: number) => void;
	/** Who a mention can name, drawn as a chip when it is finished. */
	mentionable: readonly ThreadParticipant[];
	maxLength: number;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	/** Called first; text is pasted as plain text unless this prevents it. */
	onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
	onFocus: (event: FocusEvent<HTMLDivElement>) => void;
	onBlur: (event: FocusEvent<HTMLDivElement>) => void;
	"aria-controls"?: string;
	"aria-activedescendant"?: string;
	className?: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	// Chips are drawn here, off the page, and copied into the box: React cannot draw into a box the browser edits.
	const [templates] = useState(() => document.createElement("div"));
	const composing = useRef(false);
	/** Whether the focus comes from a click, which places the caret itself. */
	const pointing = useRef(false);

	/**
	 * Draws the box again where it differs from what it holds: its chips kept,
	 * and the mentions finished in its text made chips, keeping the caret at
	 * `caret`.
	 */
	const redraw = useCallback(
		(caret?: number) => {
			const root = box.current;
			if (!root) return;
			const segments = segmentsOfBox(root, mentionable);
			if (signatureOf(segments) === drawnSignatureOf(root)) return;
			drawSegments(root, segments, templates);
			if (caret !== undefined) placeCaret(root, caret);
		},
		[mentionable, templates],
	);

	// Drawn afresh when the value changes from outside, such as a sent draft cleared or a
	// chosen mention written in.
	useLayoutEffect(() => {
		const root = box.current;
		if (!root || textOf(root) === value) return;
		drawSegments(root, segmentsOf(value, mentionable, { endFinishes: true }), templates);
		if (document.activeElement === root) placeCaret(root, value.length);
	}, [value, mentionable, templates]);

	// Drawn again when who can be mentioned changes.
	useLayoutEffect(() => {
		const root = box.current;
		redraw(root && document.activeElement === root ? caretOf(root) : undefined);
	}, [redraw]);

	useImperativeHandle(ref, () => ({
		focus: () => box.current?.focus(),
		replace: (range, text) => {
			box.current?.focus();
			replace(range, text);
		},
	}));

	// React's `onBeforeInput` is made from other events and has no `inputType`, so the browser's own is heard.
	const breakLine = useEffectEvent(() => insert("\n"));
	useEffect(() => {
		const root = box.current;
		if (!root) return;
		function keepLinesAsBreaks(event: InputEvent) {
			// Lines are breaks in the text, not the blocks the browser would add.
			if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return;
			event.preventDefault();
			breakLine();
		}
		root.addEventListener("beforeinput", keepLinesAsBreaks);
		return () => root.removeEventListener("beforeinput", keepLinesAsBreaks);
	}, []);

	// Contenteditable has no `select` event; the document says when its selection moves.
	useEffect(() => {
		function caretMoved() {
			const root = box.current;
			if (root && document.activeElement === root) onCaretChange(caretOf(root));
		}
		document.addEventListener("selectionchange", caretMoved);
		return () => document.removeEventListener("selectionchange", caretMoved);
	}, [onCaretChange]);

	/** Reads the edited box back, draws any mention it finished, and reports the text. */
	function readBack() {
		const root = box.current;
		if (!root || composing.current) return;
		const text = textOf(root).slice(0, maxLength);
		const caret = Math.min(caretOf(root), text.length);
		redraw(caret);
		onValueChange(text, caret);
	}

	/** Replaces the selection with `inserted`, as typing it would. */
	function insert(inserted: string) {
		const root = box.current;
		if (root) replace(selectionOf(root), inserted);
	}

	/** Replaces the text from `start` to `end` with `inserted`, leaving the caret after it. */
	function replace({ start, end }: TextRange, inserted: string) {
		const root = box.current;
		if (!root) return;
		const current = textOf(root);
		const text = `${current.slice(0, start)}${inserted}${current.slice(end)}`.slice(0, maxLength);
		const caret = Math.min(start + inserted.length, text.length);
		drawSegments(root, segmentsOf(text, mentionable, { endFinishes: true }), templates);
		placeCaret(root, caret);
		onValueChange(text, caret);
	}

	return (
		<div className="relative min-w-0 flex-1">
			{value === "" && (
				<span
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 truncate py-[3px] text-[15px] text-subtle-foreground leading-[22px]"
				>
					{label}
				</span>
			)}
			{/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold a mention's face. */}
			<div
				ref={box}
				id={id}
				role="textbox"
				tabIndex={0}
				contentEditable
				suppressContentEditableWarning
				aria-label={label}
				aria-multiline
				aria-autocomplete="list"
				{...aria}
				onInput={readBack}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
					readBack();
				}}
				onKeyDown={(event) => {
					onKeyDown(event);
					if (event.defaultPrevented || event.nativeEvent.isComposing) return;
					if (event.key === "Backspace" || event.key === "Delete") {
						const chip = chipBesideCaret(event.currentTarget, event.key);
						if (!chip) return;
						event.preventDefault();
						replace(chip, "");
					}
				}}
				onPaste={(event) => {
					onPaste(event);
					if (event.defaultPrevented) return;
					// Pasted as text, never as the formatting it was copied with.
					event.preventDefault();
					insert(event.clipboardData.getData("text/plain"));
				}}
				onPointerDown={(event) => {
					pointing.current = document.activeElement !== event.currentTarget;
				}}
				onFocus={(event) => {
					// A draft kept from an earlier visit is picked up at its end, not before its first
					// word, unless a click put the caret where it landed.
					if (!pointing.current)
						placeCaret(event.currentTarget, textOf(event.currentTarget).length);
					pointing.current = false;
					onFocus(event);
				}}
				onBlur={onBlur}
				className={cn(
					"block max-h-40 min-h-7 overflow-y-auto whitespace-pre-wrap break-words py-[3px] text-[15px] text-foreground leading-[22px] outline-none",
					className,
				)}
			/>
			{createPortal(
				mentionable.map((participant) => (
					<MentionChip key={participant.id} participant={participant} />
				)),
				templates,
			)}
		</div>
	);
}

/** How a finished mention is drawn in the box; copied into it from the hidden templates. */
function MentionChip({ participant }: { participant: ThreadParticipant }) {
	return (
		<span
			{...{ [MENTION_ATTRIBUTE]: `@${participant.handle}` }}
			contentEditable={false}
			className={cn(
				"mx-px inline-flex select-none items-center gap-[5px] rounded-[6px] py-px pr-1.5 pl-[3px] align-middle font-medium text-[14px] leading-[18px]",
				participant.kind === "agent"
					? "bg-bot-tint text-bot-mono"
					: "bg-chip pl-1.5 text-foreground",
			)}
			style={participant.kind === "agent" ? botColorVariables(participant.color) : undefined}
		>
			{participant.kind === "agent" && (
				<AgentAvatar
					color={participant.color}
					face={participant.face}
					shape={participant.shape}
					size={16}
					className="shrink-0"
				/>
			)}
			{participant.name}
		</span>
	);
}

/**
 * `text` split into plain runs and the finished mentions of anyone in
 * `mentionable`: those followed by whitespace, or with `endFinishes`, by the
 * end of the text, as in a draft written elsewhere.
 */
function segmentsOf(
	text: string,
	mentionable: readonly ThreadParticipant[],
	{ endFinishes }: { endFinishes: boolean },
): Segment[] {
	const parts = splitAroundMentions(text);
	const segments: Segment[] = [];
	for (const [index, part] of parts.entries()) {
		if (index % 2 === 0) {
			pushText(segments, part);
			continue;
		}
		const participant = participantWithHandle(mentionable, part);
		const after = parts[index + 1] ?? "";
		const finished =
			/^\s/.test(after) || (endFinishes && index === parts.length - 2 && after === "");
		if (participant && finished) segments.push({ kind: "mention", participant });
		else pushText(segments, `@${part}`);
	}
	return segments;
}

/**
 * What the edited box holds: the chips it has, kept while whoever they name
 * can still be mentioned, and its text with the mentions finished in it.
 */
function segmentsOfBox(root: HTMLElement, mentionable: readonly ThreadParticipant[]): Segment[] {
	const segments: Segment[] = [];
	let run = "";
	const endRun = () => {
		for (const segment of segmentsOf(run, mentionable, { endFinishes: false })) {
			if (segment.kind === "text") pushText(segments, segment.text);
			else segments.push(segment);
		}
		run = "";
	};
	root.childNodes.forEach((node, index) => {
		const handle = node instanceof HTMLElement ? node.getAttribute(MENTION_ATTRIBUTE) : null;
		const participant = handle && participantWithHandle(mentionable, handle.slice(1));
		if (!participant) {
			run += textOfNode(node, index);
			return;
		}
		endRun();
		segments.push({ kind: "mention", participant });
	});
	endRun();
	return segments;
}

function pushText(segments: Segment[], text: string) {
	const last = segments.at(-1);
	if (last?.kind === "text") last.text += text;
	else if (text !== "") segments.push({ kind: "text", text });
}

/** What `segments` draw, to tell whether the box already shows them. */
function signatureOf(segments: readonly Segment[]): string {
	return JSON.stringify({
		drawn: segments.map((segment) =>
			segment.kind === "text" ? segment.text : { mention: segment.participant.handle },
		),
		filler: needsFiller(segments),
	});
}

/**
 * Whether the box needs a filler at its end: empty, or ending in a new line,
 * for that line to have its height, or in a chip, for the caret to have
 * somewhere after it.
 */
function needsFiller(segments: readonly Segment[]): boolean {
	const last = segments.at(-1);
	return !last || last.kind === "mention" || last.text.endsWith("\n");
}

/** The signature of what the box shows now. */
function drawnSignatureOf(root: HTMLElement): string {
	const drawn: (string | { mention: string })[] = [];
	let filler = false;
	for (const node of root.childNodes) {
		if (node instanceof HTMLElement && node.hasAttribute(FILLER_ATTRIBUTE)) {
			filler = node === root.lastChild;
			continue;
		}
		if (node instanceof HTMLElement && node.hasAttribute(MENTION_ATTRIBUTE)) {
			drawn.push({ mention: (node.getAttribute(MENTION_ATTRIBUTE) ?? "").slice(1) });
		} else if (node.nodeType === Node.TEXT_NODE) {
			const last = drawn.at(-1);
			if (typeof last === "string") drawn[drawn.length - 1] = last + (node.textContent ?? "");
			else drawn.push(node.textContent ?? "");
		} else {
			// Anything the browser added, such as a line as a block, is drawn again.
			return "";
		}
	}
	return JSON.stringify({ drawn: drawn.filter((part) => part !== ""), filler });
}

function drawSegments(root: HTMLElement, segments: readonly Segment[], templates: HTMLElement) {
	const nodes: Node[] = segments.map((segment) => {
		if (segment.kind === "text") return document.createTextNode(segment.text);
		const template = templates.querySelector(
			`[${MENTION_ATTRIBUTE}="@${segment.participant.handle}"]`,
		);
		return template?.cloneNode(true) ?? document.createTextNode(`@${segment.participant.handle}`);
	});
	if (needsFiller(segments)) {
		const filler = document.createElement("br");
		filler.setAttribute(FILLER_ATTRIBUTE, "");
		nodes.push(filler);
	}
	root.replaceChildren(...nodes);
}

/** The box's text: chips as their `@handle`, lines the browser made as new lines. */
function textOf(root: Node): string {
	let text = "";
	root.childNodes.forEach((node, index) => {
		text += textOfNode(node, index);
	});
	return text;
}

function textOfNode(node: Node, index: number): string {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
	if (!(node instanceof HTMLElement)) return "";
	if (node.hasAttribute(MENTION_ATTRIBUTE)) return chipText(node);
	if (node.hasAttribute(FILLER_ATTRIBUTE)) return "";
	// The browser keeps a line break at the end of a box it empties, to give it height; it adds no line.
	if (node.tagName === "BR") return node.nextSibling ? "\n" : "";
	const inner = textOf(node);
	return (node.tagName === "DIV" || node.tagName === "P") && index > 0 ? `\n${inner}` : inner;
}

/**
 * A chip's `@handle`, and a space after it when what follows would otherwise
 * run on into the handle, as when the space after a chip is deleted: the
 * mention is still sent as one.
 */
function chipText(chip: HTMLElement): string {
	const handle = chip.getAttribute(MENTION_ATTRIBUTE) ?? "";
	const next = chip.nextSibling;
	const following =
		next instanceof HTMLElement && next.hasAttribute(MENTION_ATTRIBUTE)
			? "@"
			: (next?.textContent?.[0] ?? "");
	return RUNS_ON_INTO_MENTION.test(following) ? `${handle} ` : handle;
}

/** How far into the text a point in the box is. */
function offsetOf(root: HTMLElement, container: Node, offset: number): number {
	if (container === root || !root.contains(container)) {
		return [...root.childNodes]
			.slice(0, offset)
			.reduce((sum, node, index) => sum + textOfNode(node, index).length, 0);
	}
	let total = 0;
	for (const [index, node] of root.childNodes.entries()) {
		if (node === container || node.contains(container)) {
			if (node.nodeType === Node.TEXT_NODE) return total + offset;
			if (node instanceof HTMLElement && node.hasAttribute(MENTION_ATTRIBUTE)) {
				return total + textOfNode(node, index).length;
			}
			return total + offsetOf(node as HTMLElement, container, offset);
		}
		total += textOfNode(node, index).length;
	}
	return total;
}

/**
 * Where the chip is that `key` would remove, right before the caret for
 * Backspace or right after it for Delete; none while text is selected.
 */
function chipBesideCaret(root: HTMLElement, key: "Backspace" | "Delete"): TextRange | undefined {
	const { start, end } = selectionOf(root);
	if (start !== end) return undefined;
	let offset = 0;
	for (const [index, node] of root.childNodes.entries()) {
		const length = textOfNode(node, index).length;
		const chip = { start: offset, end: offset + length };
		const isChip = node instanceof HTMLElement && node.hasAttribute(MENTION_ATTRIBUTE);
		if (isChip && (key === "Backspace" ? chip.end : chip.start) === start) return chip;
		offset += length;
	}
	return undefined;
}

function selectionOf(root: HTMLElement): TextRange {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
		const end = textOf(root).length;
		return { start: end, end };
	}
	const range = selection.getRangeAt(0);
	return {
		start: offsetOf(root, range.startContainer, range.startOffset),
		end: offsetOf(root, range.endContainer, range.endOffset),
	};
}

function caretOf(root: HTMLElement): number {
	return selectionOf(root).end;
}

/** Puts the caret `offset` into the text, after a chip it falls inside. */
function placeCaret(root: HTMLElement, offset: number) {
	const selection = document.getSelection();
	if (!selection) return;
	const range = document.createRange();
	let remaining = offset;
	let placed = false;
	for (const [index, node] of root.childNodes.entries()) {
		const length = textOfNode(node, index).length;
		if (node.nodeType === Node.TEXT_NODE && remaining <= length) {
			range.setStart(node, remaining);
			placed = true;
			break;
		}
		if (remaining < length) {
			range.setStartAfter(node);
			placed = true;
			break;
		}
		remaining -= length;
	}
	if (!placed) {
		const filler =
			root.lastChild instanceof HTMLElement && root.lastChild.hasAttribute(FILLER_ATTRIBUTE);
		range.setStart(root, filler ? root.childNodes.length - 1 : root.childNodes.length);
	}
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}
