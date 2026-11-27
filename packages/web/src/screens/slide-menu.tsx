import { SPEAKER_NOTES } from "@sugabots/contracts/live-slides";
import { SLIDE_WIDTH } from "@sugabots/contracts/slide-geometry";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import {
	ClipboardPaste,
	ClipboardType,
	Copy,
	RotateCcw,
	Scissors,
	SquarePlus,
	Trash2,
} from "lucide-react";
import { type MouseEvent, type PointerEvent, useRef, useState } from "react";
import {
	addTextBox,
	BOX_DELETION_BLOCKED_WORDS,
	type BoxIndex,
	boxDeletionBlocked,
	boxesOf,
	boxHolding,
	canResetLayout,
	placeOfFollowedBox,
	resetLayout,
	type SlideAt,
	type SlidePoint,
	slidePoint,
	whereFollowedSlideIs,
} from "@/lib/deck.ts";
import { cutOrCopy, type PasteForm, pasteInto, readClipboard } from "@/lib/editor-clipboard.ts";
import { type FollowedNode, followNode } from "@/lib/followed-node.ts";
import { IS_MAC } from "@/lib/platform.ts";
import {
	ContextMenu,
	ContextMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
} from "@/ui/dropdown-menu.tsx";
import { deleteBoxFocusingWords, outlinedBoxOf } from "./box-outlines.tsx";
import { drawnSlideBody } from "./deck-stage.ts";
import { DRAWN_BOX } from "./slide-drawing.tsx";

/*
 * The menu of the slide on a deck's stage, which right-clicking the slide
 * opens in place of the browser's, every time: on its words, whatever is
 * selected, on a box's outline, on the slide around its boxes, or in its
 * notes. It cuts, copies and pastes as the keyboard's shortcuts do, deletes
 * the box it was opened on, as the Delete key does on the box's outline,
 * adds a text box where it was opened, and resets the slide's layout.
 * Right-clicking words outside the selection first puts the caret there, so
 * a paste goes where the person clicked; anywhere else, a right-click leaves
 * the selection as it is.
 *
 * Shift held while right-clicking opens the browser's menu instead, which
 * has its spelling suggestions, and a long press on a touch screen is left to
 * the platform. The keyboard's menu key, or Shift and F10, opens it at the
 * caret, or at the outline that has the focus. Once it closes, the focus is
 * back where it was.
 */

/** The keys that do what the menu's items do, as it names them, and as it tells the person to press when the browser refuses it. */
const KEYS = IS_MAC
	? { cut: "⌘X", copy: "⌘C", paste: "⌘V", pasteAsText: "⌥⇧⌘V", deleteBox: "⌫" }
	: {
			cut: "Ctrl+X",
			copy: "Ctrl+C",
			paste: "Ctrl+V",
			pasteAsText: "Ctrl+Shift+V",
			deleteBox: "Del",
		};

const NOTHING_TO_PASTE = "The clipboard has no text to paste.";

/** Where on the stage the menu was opened: on the slide, or in its notes, which have no boxes and no layout. */
type Region = "slide" | "notes";

/** What the menu was opened on. */
interface MenuTarget {
	region: Region;
	/** The box it was opened on: the one right-clicked, or whose outline has the focus. */
	box: BoxIndex | undefined;
	/** Whether it was opened on words, where a right-click puts the caret. */
	onWords: boolean;
}

/** A place in the window the menu opens against: a point, or the caret, as tall as its line. */
interface VirtualPoint {
	getBoundingClientRect: () => DOMRect;
}

/** The menu as it was opened, which it keeps while it fades out once closed. */
interface OpenedMenu {
	/** Where it opens: at the pointer, under the caret, or at the focused outline. */
	anchor: Element | VirtualPoint;
	region: Region;
	/**
	 * The box it offers to delete, when the slide's boxes can be edited here,
	 * followed through anybody's changes, so it deletes no other.
	 */
	box: FollowedNode | undefined;
	/** Where on the slide, in its pixels, it was opened by the pointer, where a text box it adds goes. */
	at: SlidePoint | undefined;
	/** The slide it was opened on, followed through anybody's changes, so it acts on no other. */
	slide: FollowedNode | undefined;
	/** Whether nothing was selected, which leaves nothing to cut or copy. */
	nothingSelected: boolean;
	/** What had the focus, which an item that moves it to the words gives back. */
	focused: Element | null;
}

/**
 * The menu of `slide`, the slide on the stage: `stageProps` go on the
 * element holding the editor and the boxes' outlines, which right-clicking
 * opens it from, and `menu` is the menu. `box` is the place on the slide of
 * the box it is open for, if it is, which its outline marks. `editable` says
 * whether the deck can be changed here: where it can't, the menu only
 * copies. `boxesEditable` says whether the slide's boxes can be edited here,
 * as their outlines are drawn. `notice` is what to tell the person when the
 * browser refused what they chose, until they dismiss it.
 */
export function useSlideMenu(
	editor: Editor,
	{
		slide,
		editable,
		boxesEditable,
	}: { slide: SlideAt | undefined; editable: boolean; boxesEditable: boolean },
) {
	const [open, setOpen] = useState(false);
	const [opened, setOpened] = useState<OpenedMenu>();
	const [notice, setNotice] = useState<string>();
	// The kind of pointer that last pressed on the stage, or `undefined` after a key there: the menu
	// key, or Shift and F10, opens the menu with no press.
	const pressedWith = useRef<string>(undefined);

	function openMenu(event: MouseEvent<HTMLElement>) {
		const pointer = pressedWith.current;
		const byKeyboard = pointer === undefined;
		if (!slide || !(event.target instanceof Element)) return;
		if (pointer === "touch" || (!byKeyboard && event.shiftKey)) return;
		const { view } = editor;
		const target = byKeyboard
			? keyboardTarget(view, slide, event.target)
			: pointerTarget(view, slide, event.target);
		if (!target) return;
		event.preventDefault();
		const openedOn = target.box === undefined ? undefined : boxesOf(slide.node)[target.box];
		const box = openedOn && followNode(view.state, slide.pos + openedOn.startInSlide);
		if (!byKeyboard && target.onWords && editable) putCaretAtPointer(view, event);
		setOpened({
			anchor: byKeyboard
				? keyboardAnchor(view, slide, event.target)
				: pointAt(event.clientX, event.clientY),
			region: target.region,
			box: boxesEditable ? box : undefined,
			// Opened in the notes, a text box it adds goes where one with no place said does.
			at: byKeyboard || target.region !== "slide" ? undefined : pointOnSlide(view, slide, event),
			slide: followNode(view.state, slide.pos),
			nothingSelected: view.state.selection.empty,
			focused: document.activeElement,
		});
		setOpen(true);
	}

	/** The slide the menu was opened on, if it is still the one on the stage. */
	function slideOpenedOn(): SlideAt | undefined {
		const followed = opened?.slide;
		if (!slide || !followed) return undefined;
		return whereFollowedSlideIs(editor.state.doc, followed) === slide.pos ? slide : undefined;
	}

	function cutOrCopyFromMenu(command: "cut" | "copy") {
		setNotice(undefined);
		const done = cutOrCopy(editor.view, command);
		// The words took the focus for the command; an outline that had it before gets it back.
		const focused = opened?.focused;
		if (focused instanceof HTMLElement && focused.isConnected && focused !== editor.view.dom) {
			focused.focus({ preventScroll: true });
		}
		if (!done) {
			const doing = command === "cut" ? "cutting" : "copying";
			setNotice(`Your browser didn't allow ${doing} from the menu. Press ${KEYS[command]}.`);
		}
	}

	/** Pastes what the clipboard holds, read first in full, so a paste is made whole or not at all. */
	async function pasteFromMenu(form: PasteForm) {
		setNotice(undefined);
		// Read at once, in answer to the person's choice, which some browsers require.
		const content = await readClipboard(form).catch(() => undefined);
		if (!content) {
			const keys = form === "formatted" ? KEYS.paste : KEYS.pasteAsText;
			return setNotice(`Your browser didn't allow pasting from the menu. Press ${keys}.`);
		}
		if (editor.isDestroyed || !editor.isEditable) return;
		if (!pasteInto(editor.view, content)) setNotice(NOTHING_TO_PASTE);
	}

	/** Deletes the box the menu was opened on, if it is still on the slide it was opened on. */
	function deleteBoxFromMenu() {
		const on = slideOpenedOn();
		const place = opened?.box && placeOfFollowedBox(editor.state.doc, opened.box);
		if (on && place?.slidePos === on.pos) deleteBoxFocusingWords(editor, on.pos, place.box);
	}

	function resetSlideLayout() {
		const on = slideOpenedOn();
		const resetting = on && resetLayout(editor.state, on.index);
		if (resetting) editor.view.dispatch(resetting);
	}

	function addTextBoxFromMenu() {
		const on = slideOpenedOn();
		const adding = on && addTextBox(editor.state, on.pos, opened?.at);
		if (!adding) return;
		editor.view.dispatch(adding);
		editor.view.focus();
	}

	const onSlide = editable && opened?.region === "slide";
	// Where the box the menu was opened on is now: gone, or on another slide, it is offered no more.
	const boxPlace = onSlide && opened?.box && placeOfFollowedBox(editor.state.doc, opened.box);
	const box = boxPlace && boxPlace.slidePos === slide?.pos ? boxPlace.box : undefined;
	const boxNode = boxPlace ? editor.state.doc.nodeAt(boxPlace.boxPos) : undefined;
	const deletionBlocked = boxNode && boxDeletionBlocked(editor.state, boxNode);
	// Wherever it was opened on the slide, its notes too, as a slide with no boxes leaves the caret nowhere else.
	const offersTextBox = editable && opened !== undefined;
	const offersReset = onSlide && slide !== undefined && canResetLayout(slide.node);

	const menu = (
		<ContextMenu open={open} onOpenChange={setOpen}>
			<ContextMenuContent anchor={opened?.anchor} density="compact" className="min-w-48 max-w-80">
				{editable && (
					<DropdownMenuItem
						disabled={opened?.nothingSelected}
						onClick={() => cutOrCopyFromMenu("cut")}
					>
						<Scissors aria-hidden />
						Cut
						<DropdownMenuShortcut>{KEYS.cut}</DropdownMenuShortcut>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem
					disabled={opened?.nothingSelected}
					onClick={() => cutOrCopyFromMenu("copy")}
				>
					<Copy aria-hidden />
					Copy
					<DropdownMenuShortcut>{KEYS.copy}</DropdownMenuShortcut>
				</DropdownMenuItem>
				{editable && (
					<>
						<DropdownMenuItem onClick={() => void pasteFromMenu("formatted")}>
							<ClipboardPaste aria-hidden />
							Paste
							<DropdownMenuShortcut>{KEYS.paste}</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => void pasteFromMenu("plainText")}>
							<ClipboardType aria-hidden />
							Paste without formatting
							<DropdownMenuShortcut>{KEYS.pasteAsText}</DropdownMenuShortcut>
						</DropdownMenuItem>
					</>
				)}
				{(offersTextBox || offersReset) && <DropdownMenuSeparator />}
				{offersTextBox && (
					<DropdownMenuItem onClick={addTextBoxFromMenu}>
						<SquarePlus aria-hidden />
						Add text box
					</DropdownMenuItem>
				)}
				{box !== undefined && boxNode && (
					<DropdownMenuItem
						variant="destructive"
						disabled={deletionBlocked !== undefined}
						onClick={deleteBoxFromMenu}
					>
						<Trash2 aria-hidden />
						<span className="flex flex-col">
							Delete
							{deletionBlocked && (
								<span className="text-muted-foreground text-2xs">
									{BOX_DELETION_BLOCKED_WORDS[deletionBlocked]}
								</span>
							)}
						</span>
						<DropdownMenuShortcut>{KEYS.deleteBox}</DropdownMenuShortcut>
					</DropdownMenuItem>
				)}
				{offersReset && (
					<DropdownMenuItem onClick={resetSlideLayout}>
						<RotateCcw aria-hidden />
						Reset layout
					</DropdownMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);

	return {
		stageProps: {
			onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
				pressedWith.current = event.pointerType;
			},
			onKeyDownCapture: () => {
				pressedWith.current = undefined;
			},
			// What a right-click that opens the menu selects, and where the focus goes, is the menu's to
			// decide, not the browser's: on a Mac, the browser selects the word under the pointer.
			onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
				if (event.button !== RIGHT_BUTTON || event.shiftKey || !slide) return;
				if (!(event.target instanceof Element)) return;
				if (pointerTarget(editor.view, slide, event.target)) event.preventDefault();
			},
			onContextMenu: openMenu,
		},
		menu,
		box: open ? box : undefined,
		notice,
		dismissNotice: () => setNotice(undefined),
	};
}

/** The mouse button a right-click presses, as a mouse event numbers it. */
const RIGHT_BUTTON = 2;

/** How the editor draws a slide's notes. */
const DRAWN_NOTES = "[data-speaker-notes]";

/**
 * What right-clicking `element` opens the menu on: a box's outline, a box's
 * words, the slide around its boxes, or its notes. `undefined` anywhere else
 * on the stage, such as on a suggestion's card under the slide.
 */
function pointerTarget(view: EditorView, slide: SlideAt, element: Element): MenuTarget | undefined {
	const outlined = outlinedBoxOf(element, slide.node);
	if (outlined !== undefined) return { region: "slide", box: outlined, onWords: false };
	const drawn = view.nodeDOM(slide.pos);
	if (!(drawn instanceof Element) || !drawn.contains(element)) return undefined;
	if (element.closest(DRAWN_NOTES)) return { region: "notes", box: undefined, onWords: true };
	if (!drawnSlideBody(view, slide.pos)?.contains(element)) return undefined;
	const drawnBox = element.closest(DRAWN_BOX);
	if (!drawnBox) return { region: "slide", box: undefined, onWords: false };
	const box = boxHolding(view.state.doc, view.posAtDOM(drawnBox, 0), slide.index);
	return { region: "slide", box, onWords: true };
}

/**
 * What the keyboard's menu key opens the menu on, with the focus on
 * `element`: the box whose outline has the focus, or where the caret is.
 * `undefined` for anything else on the stage with the focus, such as a
 * button on a suggestion's card.
 */
function keyboardTarget(
	view: EditorView,
	slide: SlideAt,
	element: Element,
): MenuTarget | undefined {
	const outlined = outlinedBoxOf(element, slide.node);
	if (outlined !== undefined) return { region: "slide", box: outlined, onWords: false };
	if (element !== view.dom && !pointerTarget(view, slide, element)) return undefined;
	const { $head } = view.state.selection;
	// A deck holds slides, which hold their body and then their notes.
	const inNotes = $head.depth >= 2 && $head.node(2).type.name === SPEAKER_NOTES;
	return { region: inNotes ? "notes" : "slide", box: undefined, onWords: false };
}

/** Where the keyboard's menu key opens the menu: at the outline with the focus, or under the caret. */
function keyboardAnchor(
	view: EditorView,
	slide: SlideAt,
	element: Element,
): Element | VirtualPoint {
	if (outlinedBoxOf(element, slide.node) !== undefined) return element;
	const { left, top, bottom } = view.coordsAtPos(view.state.selection.head);
	return pointAt(left, top, bottom - top);
}

const pointAt = (x: number, y: number, height = 0): VirtualPoint => ({
	getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height }),
});

/** Where on `slide` the pointer at `event` is, in the slide's pixels: `undefined` when its body isn't drawn. */
function pointOnSlide(
	view: EditorView,
	slide: SlideAt,
	{ clientX, clientY }: MouseEvent,
): SlidePoint | undefined {
	const area = drawnSlideBody(view, slide.pos)?.getBoundingClientRect();
	if (!area?.width) return undefined;
	const slidePxPerWindowPx = SLIDE_WIDTH / area.width;
	return slidePoint(
		(clientX - area.left) * slidePxPerWindowPx,
		(clientY - area.top) * slidePxPerWindowPx,
	);
}

/**
 * Gives the words the focus, and puts the caret where the right-click was,
 * unless that is in what is selected, which a right-click there keeps.
 */
function putCaretAtPointer(view: EditorView, { clientX, clientY }: MouseEvent) {
	view.focus();
	const at = view.posAtCoords({ left: clientX, top: clientY });
	const { selection, doc } = view.state;
	if (!at || (!selection.empty && at.pos >= selection.from && at.pos <= selection.to)) return;
	view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(at.pos))));
}
