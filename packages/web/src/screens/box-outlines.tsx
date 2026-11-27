import { layoutOf } from "@sugabots/contracts/live-slides";
import type { BoxRole } from "@sugabots/contracts/slide-box";
import { type Frame, SLIDE_HEIGHT, SLIDE_WIDTH } from "@sugabots/contracts/slide-geometry";
import type { Node } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { type Editor, useEditorState } from "@tiptap/react";
import {
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useEffectEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type Arranged,
	HANDLES,
	type Handle,
	movedFrame,
	movesEdge,
	NO_SNAP_LINES,
	resizedFrame,
	type Shift,
	sameFrame,
	snapLinesAround,
} from "@/lib/box-frames.ts";
import {
	BOX_REMOVAL_BLOCKED_WORDS,
	type BoxIndex,
	type BoxOfSlide,
	boxesOf,
	boxHolding,
	boxIndexIn,
	boxRemovalBlocked,
	placeBox,
	placeOfFollowedBox,
	removeBox,
	type SlideAt,
	type SlideIndex,
	type SlidePos,
	slidesOf,
} from "@/lib/deck.ts";
import { type FollowedNode, followNode } from "@/lib/followed-node.ts";
import { IS_MAC } from "@/lib/platform.ts";
import { drawnSlideBody, previewingBox, withoutBoxPreview } from "./deck-stage.ts";

/*
 * Moving and resizing the boxes of the slide on a deck's stage by hand, as
 * a slide editor does, drawn over the slide. The box being edited, the one
 * being dragged, holding the caret while the stage has the focus, or whose
 * outline has it, is outlined, with a handle at each corner and side to
 * resize it from; a box the pointer is over is outlined faintly. A slide
 * comes onto the stage with none of its boxes being edited, though the caret
 * is in the first of them: the box holding the caret is edited only once the
 * person presses the pointer, or a key, on the stage. Dragging a box's
 * outline moves it, snapping to what it comes close to lining up with,
 * and dragging inside it selects its words, as ever. With its outline
 * focused, by a click or by Tab, the arrow keys move it, Delete or Backspace
 * deletes it, one box a press however long the key is held, and Escape goes
 * back to its words. Each of its controls says so in words to assistive
 * technology, which is told where a box a key moved now is, and why a box
 * can't be deleted when it can't. The slide's menu, right-clicking its
 * outline or its words, offers to delete it too (see `slide-menu.tsx`), and
 * the box stays outlined while the menu is open for it. Pressed on an
 * outline, which is outside the editor, the keys that undo and redo in the
 * editor (`historyKey`) undo and redo there too.
 *
 * A drag is drawn as it goes, in this editor only, and written to the deck
 * once, when it ends, so it is one change to undo, and one for the others to
 * receive. It keeps to its slide through anybody's changes, and ends,
 * unwritten, once the slide, or the box it drags, is gone. An outline is
 * drawn at its box's frame, unturned however the box is turned.
 */

/**
 * How far outside a box its band, which moves it, reaches, so a press at the
 * very start of its words still puts the caret there. The rest of the band is
 * a little way inside it (see `app.css`).
 */
const BAND_OUTSIDE_WINDOW_PX = 6;

/** How far the pointer must go for a press on a box's outline to be a drag and not a click. */
const DRAG_THRESHOLD_WINDOW_PX = 3;

/** How far an arrow key moves a box, or a side of one, and with Shift held. */
const NUDGE_SLIDE_PX = 1;
const NUDGE_WITH_SHIFT_SLIDE_PX = 10;

/** A way an arrow key moves a box: back, not at all, or on, by a step across, and by a step down. */
interface Direction {
	across: -1 | 0 | 1;
	down: -1 | 0 | 1;
}

/** Which way each arrow key moves a box. */
const ARROWS: Partial<Record<string, Direction>> = {
	ArrowLeft: { across: -1, down: 0 },
	ArrowRight: { across: 1, down: 0 },
	ArrowUp: { across: 0, down: -1 },
	ArrowDown: { across: 0, down: 1 },
};

/**
 * What `box` is called on its outline's controls: a noun phrase, as read in
 * "Move …" and in "Resize … from the top left". A box for nothing in
 * particular is called for what it holds, or for its shape.
 */
function boxNameOf({ node, attributes }: BoxOfSlide): string {
	if (attributes.role) return BOX_NAMES[attributes.role];
	if (node.firstChild?.type.name === "table") return "the table";
	if (attributes.path) return "the shape";
	return "the text box";
}

/** What a box of each role is called on its outline's controls. */
const BOX_NAMES: Record<BoxRole, string> = {
	title: "the title",
	subtitle: "the subtitle",
	body: "the text",
	leftColumn: "the left column",
	rightColumn: "the right column",
	text: "the text",
	image: "the image",
	label: "the label",
	quote: "the quote",
	attribution: "the attribution",
	table: "the table",
};

/** Carries the place on its slide of the box an outline is drawn for, by which `outlinedBoxOf` finds it. */
const OUTLINED_BOX_ATTRIBUTE = "data-outlined-box";

/** The box of `slide` whose outline holds `element`, if an outline does. */
export function outlinedBoxOf(element: Element, slide: Node): BoxIndex | undefined {
	const place = element
		.closest(`[${OUTLINED_BOX_ATTRIBUTE}]`)
		?.getAttribute(OUTLINED_BOX_ATTRIBUTE);
	return place === null || place === undefined ? undefined : boxIndexIn(slide, Number(place));
}

/**
 * Deletes the box at `box` from the slide starting at `slidePos`, if it can be
 * deleted now (`removeBox`), and gives the slide's words the focus, as the
 * box's outline goes with it. Answers whether it deleted it.
 */
export function removeBoxFocusingWords(editor: Editor, slidePos: SlidePos, box: BoxIndex): boolean {
	const removing = removeBox(editor.state, slidePos, box);
	if (!removing) return false;
	editor.view.dispatch(removing);
	editor.view.focus();
	return true;
}

/**
 * The outlines of the boxes of `slide`, the slide on the stage, drawn over it
 * inside `stage`, the positioned element holding the editor, with what moves
 * and resizes them. Only for a slide whose boxes can be moved here. Given
 * another slide, it is to be drawn anew: what it keeps of its boxes, it keeps
 * by their places on the slide.
 */
export function BoxOutlines({
	editor,
	slide,
	stage,
	menuFor,
}: {
	editor: Editor;
	slide: SlideAt;
	stage: RefObject<HTMLElement | null>;
	/** The box that the slide's menu is open for, which is the one being edited until it closes. */
	menuFor: BoxIndex | undefined;
}) {
	const drawn = useDrawnSlide(editor.view, slide, stage);
	const holdingCaret = useEditorState({
		editor,
		selector: ({ editor: current }) =>
			boxHolding(current.state.doc, current.state.selection.head, slide.index),
	});
	const stageFocused = useFocusWithin(stage);
	// The outlines are drawn anew for each slide, so this is whether the person has acted on this one.
	const actedOnSlide = useActedOn(stage);
	// The box whose outline, or one of whose handles, has the focus.
	const [focused, setFocused] = useState<BoxIndex>();
	const [hovered, setHovered] = useState<BoxIndex>();
	// What assistive technology was last told, numbered so the same words told again are told again.
	const [announced, setAnnounced] = useState<{ words: string; count: number }>();
	const hints = { move: useId(), resize: useId() };
	const overlay = useRef<HTMLDivElement>(null);
	const boxes = boxesOf(slide.node);
	const { drag, dragged, startDrag } = useBoxDrag(editor, slide);
	const frames = boxes.map(({ attributes }, index) =>
		index === dragged && drag?.moved ? drag.moved.frame : attributes.frame,
	);

	const hover = useEffectEvent((event: globalThis.PointerEvent) => {
		// The box being dragged stays the one outlined, wherever the pointer goes.
		if (drag) return;
		const area = overlay.current?.getBoundingClientRect();
		setHovered(area ? boxUnder(frames, area, event) : undefined);
	});
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const move = (event: globalThis.PointerEvent) => hover(event);
		const leave = () => setHovered(undefined);
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerleave", leave);
		return () => {
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerleave", leave);
		};
	}, [stage]);

	const onSlide = (box: BoxIndex | undefined) =>
		box !== undefined && box < boxes.length ? box : undefined;
	const editing =
		dragged ??
		onSlide(menuFor) ??
		onSlide(focused) ??
		(stageFocused && actedOnSlide ? onSlide(holdingCaret) : undefined);

	// An outline can lose the focus without a blur, as when it goes with its box: what says it has
	// the focus is then let go, and the focus, unless something else has taken it, goes back to the
	// slide's words rather than nowhere.
	useEffect(() => {
		if (focused === undefined || overlay.current?.contains(document.activeElement)) return;
		setFocused(undefined);
		if (nothingFocused()) editor.view.focus();
	});
	// Going, as when the stage comes to show another slide, the outlines give the focus they
	// have to the slide's words, while they still have it.
	useLayoutEffect(
		() => () => {
			if (!editor.isDestroyed && overlay.current?.contains(document.activeElement)) {
				editor.view.focus();
			}
		},
		[editor],
	);

	if (!drawn) return null;

	const announce = (words: string) =>
		setAnnounced((before) => ({ words, count: (before?.count ?? 0) + 1 }));

	/**
	 * Acts on a key pressed on the outline of the box at `box`, or on its
	 * `handle`: an arrow moves the box, or the handle's sides; Delete or
	 * Backspace deletes it; the editor's keys for undo and redo undo and redo
	 * there; and Escape goes back to its words, or, during a drag, ends it.
	 */
	function actOnKey(event: KeyboardEvent<HTMLElement>, box: BoxIndex, handle: Handle | undefined) {
		if (drag) {
			if (event.key !== "Escape") return;
			event.preventDefault();
			return drag.cancel();
		}
		if (event.key === "Escape") {
			event.preventDefault();
			return editWordsOf(editor, slide.index, box);
		}
		const history = historyKey(event);
		if (history) {
			event.preventDefault();
			return void (history === "undo" ? editor.commands.undo() : editor.commands.redo());
		}
		if (isRemoveKey(event)) {
			event.preventDefault();
			// A key held down repeats, and one press removes one box.
			if (event.repeat) return;
			if (removeBoxFocusingWords(editor, slide.pos, box)) return ignoreRestOfPress(event.key);
			const removed = boxes[box];
			const blocked = removed && boxRemovalBlocked(editor.state, removed.node);
			if (blocked) announce(BOX_REMOVAL_BLOCKED_WORDS[blocked]);
			return;
		}
		const direction = ARROWS[event.key];
		if (!direction) return;
		event.preventDefault();
		const startFrame = boxes[box]?.attributes.frame;
		if (!startFrame) return;
		const step = event.shiftKey ? NUDGE_WITH_SHIFT_SLIDE_PX : NUDGE_SLIDE_PX;
		const by: Shift = { dx: direction.across * step, dy: direction.down * step };
		const { frame } = handle
			? resizedFrame(startFrame, handle, by, NO_SNAP_LINES)
			: movedFrame(startFrame, by, NO_SNAP_LINES);
		const placing = placeBox(editor.state, slide.pos, box, frame);
		if (!placing) return;
		editor.view.dispatch(placing);
		announce(
			handle
				? `Resized to ${frame.width} wide and ${frame.height} tall.`
				: `Moved to ${frame.x} across and ${frame.y} down.`,
		);
	}

	return (
		<div
			ref={overlay}
			className="box-outlines"
			style={
				{
					left: drawn.left,
					top: drawn.top,
					width: drawn.width,
					"--band-outside": `${BAND_OUTSIDE_WINDOW_PX}px`,
				} as CSSProperties
			}
		>
			{boxes.map((box) => {
				const { index } = box;
				const frame = frames[index];
				if (!frame || (index !== editing && index !== hovered)) return null;
				return (
					<BoxOutline
						// A box has no lasting id, so its place is its key, which keeps a drag's element through a drag.
						key={index}
						box={index}
						frame={frame}
						name={boxNameOf(box)}
						editing={index === editing}
						dragging={index === dragged && drag?.moved !== undefined}
						hints={hints}
						onFocusChange={(focusing) =>
							setFocused((now) => (focusing ? index : now === index ? undefined : now))
						}
						onDragStart={(event, handle) => startDrag(event, index, handle)}
						onKeyDown={(event, handle) => actOnKey(event, index, handle)}
					/>
				);
			})}
			{drag?.moved?.guides.map((guide) => (
				<span
					key={`${guide.direction} ${guide.at}`}
					aria-hidden
					className="box-guide"
					data-direction={guide.direction}
					style={
						guide.direction === "down"
							? { left: percent(guide.at / SLIDE_WIDTH) }
							: { top: percent(guide.at / SLIDE_HEIGHT) }
					}
				/>
			))}
			<span id={hints.move} hidden>
				Arrow keys move the box, further with Shift held. Delete deletes it. Escape goes back to its
				text.
			</span>
			<span id={hints.resize} hidden>
				Arrow keys resize the box from here, further with Shift held. Delete deletes it. Escape goes
				back to its text.
			</span>
			<span role="status" className="sr-only">
				{announced && <span key={announced.count}>{announced.words}</span>}
			</span>
		</div>
	);
}

/** A drag under way of one of a slide's boxes. */
interface BoxDrag {
	/** The box being dragged, followed through anybody's changes (see `followNode`). */
	followed: FollowedNode;
	/** Where the drag has the box, and the lines it has snapped to, once it has moved. */
	moved?: Arranged;
	/** Ends the drag without writing it. */
	cancel: () => void;
}

/**
 * Dragging the boxes of `slide`, the slide on the stage, by their outlines:
 * the drag under way, if there is one, the place on the slide now of the box
 * it drags, which others' changes can shift, and how to start one from a
 * press on the outline of the box at `box`, or on its `handle`. The drag is
 * the pointer's wherever it goes, whatever becomes of the element pressed,
 * and keeps to its box through anybody's changes, as they go on drawing
 * theirs. It ends, unwritten, once the box is gone from the slide, or once
 * the outlines go.
 */
function useBoxDrag(editor: Editor, slide: SlideAt) {
	const [drag, setDrag] = useState<BoxDrag>();
	const cancelDrag = drag?.cancel;
	// Ends the drag under way when the outlines go. When a drag ends otherwise, this runs too, and
	// does nothing.
	useLayoutEffect(() => cancelDrag, [cancelDrag]);
	const place = drag && placeOfFollowedBox(editor.state.doc, drag.followed);
	const dragged = place?.slidePos === slide.pos ? place.box : undefined;
	const boxGone = drag !== undefined && dragged === undefined;
	useEffect(() => {
		if (boxGone) cancelDrag?.();
	}, [boxGone, cancelDrag]);

	function startDrag(event: PointerEvent<HTMLElement>, box: BoxIndex, handle: Handle | undefined) {
		if (event.button !== 0 || event.pointerType === "touch" || drag) return;
		const start = drawnSlide(editor.view, slide);
		const startBox = boxesOf(slide.node)[box];
		const followed = startBox && followNode(editor.state, slide.pos + startBox.startInSlide);
		if (!start || !startBox || !followed) return;
		const startFrame = startBox.attributes.frame;
		event.preventDefault();
		const control = event.currentTarget;
		const { pointerId } = event;
		control.focus({ preventScroll: true });
		control.setPointerCapture(pointerId);
		const lines = snapLinesAround(
			start.frames.filter((_, index) => index !== box),
			layoutOf(slide.node),
		);
		const from = pointOnSlide(start, event);
		let pointer: ClientPoint = { clientX: event.clientX, clientY: event.clientY };
		let arranged: Arranged | undefined;
		let ended = false;

		const cancel = () => end("discard");
		/**
		 * Arranges the box by where the pointer is on the slide now, measured
		 * where the slide is drawn now, which moves under the pointer as the
		 * page scrolls.
		 */
		const follow = () => {
			const place = placeOfFollowedBox(editor.state.doc, followed);
			const area = place && drawnSlideBody(editor.view, place.slidePos)?.getBoundingClientRect();
			if (!place || !area?.width) return end("discard");
			const at = pointOnSlide(area, pointer);
			const by: Shift = { dx: at.x - from.x, dy: at.y - from.y };
			const movedWindowPx = Math.hypot(by.dx, by.dy) * (area.width / SLIDE_WIDTH);
			if (!arranged && movedWindowPx < DRAG_THRESHOLD_WINDOW_PX) return;
			arranged = handle
				? resizedFrame(startFrame, handle, by, lines)
				: movedFrame(startFrame, by, lines);
			setDrag({ followed, moved: arranged, cancel });
			editor.view.dispatch(
				previewingBox(editor.state, { pos: place.boxPos, followed }, arranged.frame),
			);
		};
		const move = (moving: globalThis.PointerEvent) => {
			if (moving.pointerId !== pointerId) return;
			pointer = { clientX: moving.clientX, clientY: moving.clientY };
			follow();
		};
		const release = (released: globalThis.PointerEvent) => {
			if (released.pointerId === pointerId) end("write");
		};
		const interrupted = (stopped: globalThis.PointerEvent) => {
			if (stopped.pointerId === pointerId) end("discard");
		};
		/** Ends the drag, writing where it has the box to the deck, or discarding it. */
		const end = (outcome: "write" | "discard") => {
			if (ended) return;
			ended = true;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", interrupted);
			window.removeEventListener("scroll", follow, true);
			if (control.hasPointerCapture(pointerId)) control.releasePointerCapture(pointerId);
			setDrag(undefined);
			if (!arranged || editor.isDestroyed) return;
			const place = placeOfFollowedBox(editor.state.doc, followed);
			const placing =
				outcome === "write" && place
					? placeBox(editor.state, place.slidePos, place.box, arranged.frame)
					: undefined;
			editor.view.dispatch(withoutBoxPreview(placing ?? editor.state.tr));
		};
		// On the window, which outlasts the element pressed: it can go mid-drag, with its box.
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", interrupted);
		window.addEventListener("scroll", follow, { capture: true, passive: true });
		setDrag({ followed, cancel });
	}

	return { drag, dragged, startDrag };
}

/**
 * One box's outline: the band along it that moves the box, and, while it is
 * being edited, the handles that resize it, hidden while it is dragged.
 */
function BoxOutline({
	box,
	frame,
	name,
	editing,
	dragging,
	hints,
	onFocusChange,
	onDragStart,
	onKeyDown,
}: {
	box: BoxIndex;
	frame: Frame;
	/** What the box is called, as `BOX_NAMES` says it. */
	name: string;
	editing: boolean;
	/** Whether the box is being moved or resized by a drag, when its outline is a line and nothing else. */
	dragging: boolean;
	/** The ids of the elements that say in words what the keys do on its band, and on a handle. */
	hints: { move: string; resize: string };
	/** Told when its band or one of its handles takes the focus, and when the focus leaves all of them. */
	onFocusChange: (focused: boolean) => void;
	/** Told of a press on its band, to move it, or on one of its handles, to resize it from there. */
	onDragStart: (event: PointerEvent<HTMLElement>, handle: Handle | undefined) => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>, handle: Handle | undefined) => void;
}) {
	const outline = useRef<HTMLDivElement>(null);
	const focusing = {
		onFocus: () => onFocusChange(true),
		// Going between its band and its handles keeps it the box being edited, and its handles drawn.
		onBlur: (event: FocusEvent<HTMLElement>) => {
			if (!outline.current?.contains(event.relatedTarget as globalThis.Node | null)) {
				onFocusChange(false);
			}
		},
	};
	return (
		<div
			ref={outline}
			className="box-outline"
			data-editing={editing ? "" : undefined}
			data-dragging={dragging ? "" : undefined}
			{...{ [OUTLINED_BOX_ATTRIBUTE]: box }}
			style={outlineStyle(frame)}
		>
			<button
				type="button"
				className="box-move"
				aria-label={`Move ${name}`}
				aria-describedby={hints.move}
				onPointerDown={(event) => onDragStart(event, undefined)}
				onKeyDown={(event) => onKeyDown(event, undefined)}
				{...focusing}
			/>
			{editing &&
				HANDLES.map((handle) => (
					<button
						key={handle}
						type="button"
						className="box-handle"
						aria-label={`Resize ${name} from the ${handle.replace("-", " ")}`}
						aria-describedby={hints.resize}
						style={handleStyle(handle)}
						onPointerDown={(event) => onDragStart(event, handle)}
						onKeyDown={(event) => onKeyDown(event, handle)}
						{...focusing}
					>
						<span aria-hidden />
					</button>
				))}
		</div>
	);
}

/**
 * Where `handle` sits on its box's outline, as parts of the box's width and
 * height, by the edges it moves, and the pointer over it: along a side, the
 * pointer points across the side, and at a corner, along the diagonal through
 * the corner.
 */
function handleStyle(handle: Handle): CSSProperties {
	const across = movesEdge(handle, "left") ? 0 : movesEdge(handle, "right") ? 1 : 0.5;
	const down = movesEdge(handle, "top") ? 0 : movesEdge(handle, "bottom") ? 1 : 0.5;
	const cursor =
		across === 0.5
			? "ns-resize"
			: down === 0.5
				? "ew-resize"
				: across === down
					? "nwse-resize"
					: "nesw-resize";
	return { left: percent(across), top: percent(down), cursor };
}

const percent = (fraction: number) => `${fraction * 100}%`;

/** Where an outline is drawn over the slide for a box framed at `frame`, as parts of the slide's width and height. */
const outlineStyle = ({ x, y, width, height }: Frame): CSSProperties => ({
	left: percent(x / SLIDE_WIDTH),
	top: percent(y / SLIDE_HEIGHT),
	width: percent(width / SLIDE_WIDTH),
	height: percent(height / SLIDE_HEIGHT),
});

/** Where the pointer is in the window, as a pointer event gives it. */
interface ClientPoint {
	clientX: number;
	clientY: number;
}

/** Where a slide's body is drawn in the window, by its top left corner and width, in the window's pixels. */
interface DrawnArea {
	left: number;
	top: number;
	width: number;
}

/** Where the pointer at `point` is on a slide whose body is drawn at `area` in the window, in the slide's pixels. */
function pointOnSlide(area: DrawnArea, { clientX, clientY }: ClientPoint) {
	const windowPxPerSlidePx = area.width / SLIDE_WIDTH;
	return {
		x: (clientX - area.left) / windowPxPerSlidePx,
		y: (clientY - area.top) / windowPxPerSlidePx,
	};
}

/** Where a slide's body is drawn (see `drawnSlide`), and where its boxes are on it. */
interface DrawnSlide extends DrawnArea {
	frames: readonly Frame[];
}

/**
 * Where the editor draws the body of `slide` now, measured from the top left
 * corner of `relativeTo`, or of the window without it, and where its boxes
 * are on it: at their frames.
 */
function drawnSlide(
	view: EditorView,
	slide: SlideAt,
	relativeTo?: Element,
): DrawnSlide | undefined {
	const body = drawnSlideBody(view, slide.pos);
	if (!body) return undefined;
	const area = body.getBoundingClientRect();
	const origin = relativeTo?.getBoundingClientRect() ?? { left: 0, top: 0 };
	return {
		left: area.left - origin.left,
		top: area.top - origin.top,
		width: area.width,
		frames: boxesOf(slide.node).map(({ attributes }) => attributes.frame),
	};
}

/**
 * Where `slide` is drawn in `stage`, measured again whenever it changes or
 * the stage or the slide changes size.
 */
function useDrawnSlide(
	view: EditorView,
	slide: SlideAt,
	stage: RefObject<HTMLElement | null>,
): DrawnSlide | undefined {
	const [drawn, setDrawn] = useState<DrawnSlide>();
	const measure = useEffectEvent(() => {
		const element = stage.current;
		const now = element ? drawnSlide(view, slide, element) : undefined;
		setDrawn((before) => (before && now && sameDrawnSlide(before, now) ? before : now));
	});
	// Each element whose size moves the slide is watched once, from when it is first drawn.
	const resized = useRef<{ observer: ResizeObserver; watched: WeakSet<Element> }>(undefined);
	const watchSizes = useEffectEvent(() => {
		const body = drawnSlideBody(view, slide.pos);
		if (!resized.current || !stage.current || !body) return;
		const { observer, watched } = resized.current;
		for (const element of [stage.current, body]) {
			if (watched.has(element)) continue;
			watched.add(element);
			observer.observe(element);
		}
	});
	useEffect(() => {
		const observer = new ResizeObserver(() => measure());
		resized.current = { observer, watched: new WeakSet() };
		watchSizes();
		return () => {
			observer.disconnect();
			resized.current = undefined;
		};
	}, []);
	const { node, pos } = slide;
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured again, and what is drawn anew watched, whenever the slide changes.
	useLayoutEffect(() => {
		measure();
		watchSizes();
	}, [node, pos]);
	return drawn;
}

const sameDrawnSlide = (one: DrawnSlide, other: DrawnSlide) =>
	one.left === other.left &&
	one.top === other.top &&
	one.width === other.width &&
	one.frames.length === other.frames.length &&
	one.frames.every((frame, index) => {
		const twin = other.frames[index];
		return twin !== undefined && sameFrame(frame, twin);
	});

/**
 * The last of the boxes framed at `frames`, the one drawn over any before
 * it, whose frame, or band, is under the pointer at `event`, on a slide
 * drawn at `area` in the window.
 */
function boxUnder(
	frames: readonly Frame[],
	area: DrawnArea,
	event: globalThis.PointerEvent,
): BoxIndex | undefined {
	const reachSlidePx = (BAND_OUTSIDE_WINDOW_PX * SLIDE_WIDTH) / area.width;
	const { x, y } = pointOnSlide(area, event);
	const index = frames.findLastIndex(
		(frame) =>
			x >= frame.x - reachSlidePx &&
			x <= frame.x + frame.width + reachSlidePx &&
			y >= frame.y - reachSlidePx &&
			y <= frame.y + frame.height + reachSlidePx,
	);
	return index < 0 ? undefined : (index as BoxIndex);
}

/**
 * Which of the keys that undo and redo in the editor `event` is, if it is
 * one: ⌘Z on a Mac and Ctrl+Z elsewhere to undo, with Shift, or Y in place of
 * Z, to redo.
 */
function historyKey(event: KeyboardEvent): "undo" | "redo" | undefined {
	const command = IS_MAC ? event.metaKey : event.ctrlKey;
	if (!command || event.altKey) return undefined;
	const key = event.key.toLowerCase();
	if (key === "z") return event.shiftKey ? "redo" : "undo";
	if (key === "y" && !event.shiftKey) return "redo";
	return undefined;
}

/** Whether `event` is Delete or Backspace alone, which removes a box. */
const isRemoveKey = (event: KeyboardEvent) =>
	(event.key === "Delete" || event.key === "Backspace") &&
	!event.ctrlKey &&
	!event.metaKey &&
	!event.altKey;

/**
 * Keeps the rest of the press of `key` under way from doing anything, as
 * after it removed a box: the focus is then in the slide's words, where the
 * key, held down, would repeat, and go on to delete them. It ends once the key
 * is let go, or, should that go unseen, as outside the window, once it is
 * pressed again.
 */
function ignoreRestOfPress(key: string) {
	const ignore = (event: globalThis.KeyboardEvent) => {
		if (event.key !== key) return;
		if (!event.repeat) return stop();
		event.preventDefault();
		event.stopPropagation();
	};
	const letGo = (event: globalThis.KeyboardEvent) => {
		if (event.key === key) stop();
	};
	function stop() {
		window.removeEventListener("keydown", ignore, true);
		window.removeEventListener("keyup", letGo, true);
	}
	// Caught on its way down, before anything in the page, the editor among them, sees it.
	window.addEventListener("keydown", ignore, true);
	window.addEventListener("keyup", letGo, true);
}

/** Whether nothing in the page has the focus, as when what had it went. */
const nothingFocused = () =>
	document.activeElement === null || document.activeElement === document.body;

/**
 * Puts the focus back in the words of the box at `box` on the slide at
 * `slideIndex`: where the caret is, if it is in them, or at their start.
 */
function editWordsOf(editor: Editor, slideIndex: SlideIndex, box: BoxIndex) {
	const { state, view } = editor;
	const slide = slidesOf(state.doc)[slideIndex];
	if (slide && boxHolding(state.doc, state.selection.head, slideIndex) !== box) {
		const target = boxesOf(slide.node)[box];
		if (!target) return;
		const start = slide.pos + target.startInSlide;
		view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(start + 1))));
	}
	view.focus();
}

/** Whether the focus is in `element`, kept up to date. */
function useFocusWithin(element: RefObject<HTMLElement | null>): boolean {
	const [within, setWithin] = useState(false);
	useEffect(() => {
		const observed = element.current;
		if (!observed) return;
		setWithin(observed.contains(document.activeElement));
		const focused = () => setWithin(true);
		const blurred = (event: globalThis.FocusEvent) =>
			setWithin(observed.contains(event.relatedTarget as globalThis.Node | null));
		observed.addEventListener("focusin", focused);
		observed.addEventListener("focusout", blurred);
		return () => {
			observed.removeEventListener("focusin", focused);
			observed.removeEventListener("focusout", blurred);
		};
	}, [element]);
	return within;
}

/**
 * Whether the person has pressed the pointer on `stage`, or a key with the
 * focus in it, since the component calling this was first drawn. The repeats
 * of a key held down are not counted, so a key held down from before, as on
 * the strip of slides, is not counted either.
 */
function useActedOn(stage: RefObject<HTMLElement | null>): boolean {
	const [acted, setActed] = useState(false);
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const pressed = () => setActed(true);
		const keyPressed = (event: globalThis.KeyboardEvent) => {
			if (!event.repeat) setActed(true);
		};
		// Caught on their way down to what they press, before anything in `element` acts on them. A
		// press there that brings another slide onto the stage, as a key moving the caret into it, has
		// then gone past `element` before a component drawn for that slide listens, so it is not
		// counted on that slide.
		element.addEventListener("pointerdown", pressed, true);
		element.addEventListener("keydown", keyPressed, true);
		return () => {
			element.removeEventListener("pointerdown", pressed, true);
			element.removeEventListener("keydown", keyPressed, true);
		};
	}, [stage]);
	return acted;
}
