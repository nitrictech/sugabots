import { isRemovedBox, placementOf } from "@sugabots/contracts/live-slides";
import { type Frame, SLIDE_HEIGHT, SLIDE_WIDTH } from "@sugabots/contracts/slides-markdown";
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
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type Arranged,
	frameOfDrawnBox,
	type Guide,
	HANDLES,
	type Handle,
	movedFrame,
	NO_SNAP_LINES,
	REMOVED_BOX_FRAME,
	resizedFrame,
	type Shift,
	sameFrame,
	snapLinesAround,
} from "@/lib/box-frames.ts";
import { boxAt, type PlacedSlide, placeBox, removeBox, slidesOf } from "@/lib/deck.ts";
import { type FollowedNode, whereFollowedNodeIs } from "@/lib/followed-node.ts";
import { IS_MAC } from "@/lib/platform.ts";
import { BOX_NAMES, drawnSlideBody, previewingBoxes, withoutBoxesPreview } from "./deck-stage.ts";
import { rolesOfBoxes } from "./slide-drawing.tsx";

/*
 * Moving and resizing the boxes of the slide on a deck's stage by hand, as
 * a slide editor does, drawn over the slide. The box being edited, the one
 * being dragged, holding the caret while the stage has the focus, or whose
 * outline has it, is outlined, with a handle at each corner and side to
 * resize it from; a box the pointer is over is outlined faintly. Dragging a
 * box's outline moves it, snapping to what it comes close to lining up with,
 * and dragging inside it selects its words, as ever. With its outline
 * focused, by a click or by Tab, the arrow keys move it, Delete or Backspace
 * removes it from the slide, one box a press however long the key is held,
 * and Escape goes back to its words. The slide's menu, right-clicking its
 * outline or its words, offers to remove it too (see `slide-menu.tsx`), and
 * the box stays outlined while the menu is open for it. The outline is outside
 * the editor, so it passes the editor's keys for undo and redo to the editor.
 *
 * A drag is drawn as it goes, in this editor only, and written to the deck
 * once, when it ends, so it is one change to undo, and one for the others to
 * receive. It keeps to its slide through anybody's changes, and ends,
 * unwritten, once the slide, or the box it drags, is gone. The first box
 * moved on a slide its layout places places them all where the layout draws
 * them, so nothing else on it moves. A box removed from the slide has no
 * outline, and nothing snaps to it.
 */

/**
 * How far outside a box its band, which moves it, reaches, in the window's
 * pixels, so a press at the very start of its words still puts the caret
 * there. The rest of the band is a little way inside it (see `app.css`).
 */
const BAND_OUTSIDE_PX = 6;

/** How far the pointer must go, in the window's pixels, for a press on a box's outline to be a drag and not a click. */
const DRAG_THRESHOLD_PX = 3;

/** How far an arrow key moves a box, or a side of one, in a slide's pixels, and with Shift held. */
const NUDGE = 1;
const NUDGE_WITH_SHIFT = 10;

/** Which way each arrow key moves a box. */
const ARROWS: Partial<Record<string, Shift>> = {
	ArrowLeft: { dx: -1, dy: 0 },
	ArrowRight: { dx: 1, dy: 0 },
	ArrowUp: { dx: 0, dy: -1 },
	ArrowDown: { dx: 0, dy: 1 },
};

/** The keys an outline says it acts on, for assistive technology: the arrows, and the keys that remove its box. */
const OUTLINE_KEYS = [...Object.keys(ARROWS), "Delete", "Backspace"].join(" ");

/** Carries the place on its slide of the box an outline is drawn for, by which `outlinedBoxOf` finds it. */
const OUTLINED_BOX_ATTRIBUTE = "data-outlined-box";

/** The place on the slide of the box whose outline holds `element`, if an outline does. */
export function outlinedBoxOf(element: Element): number | undefined {
	const place = element
		.closest(`[${OUTLINED_BOX_ATTRIBUTE}]`)
		?.getAttribute(OUTLINED_BOX_ATTRIBUTE);
	return place === null || place === undefined ? undefined : Number(place);
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
	followed,
	stage,
	menuFor,
}: {
	editor: Editor;
	slide: PlacedSlide;
	/** `slide`, followed through anybody's changes (see `followNode`). */
	followed: FollowedNode;
	stage: RefObject<HTMLElement | null>;
	/** The box, by its place on the slide, that the slide's menu is open for, which is the one being edited until it closes. */
	menuFor: number | undefined;
}) {
	const drawn = useDrawnSlide(editor.view, slide, stage);
	const holdingCaret = useEditorState({
		editor,
		selector: ({ editor: current }) =>
			boxAt(current.state.doc, current.state.selection.head, slide.index),
	});
	const stageFocused = useFocusWithin(stage);
	// The box whose outline, or one of whose handles, has the focus.
	const [focused, setFocused] = useState<number>();
	const [hovered, setHovered] = useState<number>();
	const overlay = useRef<HTMLDivElement>(null);
	const roles = rolesOfBoxes(slide.node);
	// Which boxes, by place, have an outline: those on the slide that are for something.
	const outlined = slide.node
		.child(0)
		.children.map((box, index) => roles[index] !== undefined && !isRemovedBox(box));
	const { drag, startDrag } = useBoxDrag(editor, slide, followed, outlined);
	const frames = drag?.moved?.frames ?? placementOf(slide.node) ?? drawn?.frames;

	const hover = useEffectEvent((event: globalThis.PointerEvent) => {
		// The box being dragged stays the one outlined, wherever the pointer goes.
		if (drag) return;
		const area = overlay.current?.getBoundingClientRect();
		setHovered(area && frames ? boxUnder(frames, outlined, area, event) : undefined);
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

	const withOutline = (box: number | undefined) =>
		box !== undefined && outlined[box] ? box : undefined;
	const editing =
		drag?.box ??
		withOutline(menuFor) ??
		withOutline(focused) ??
		(stageFocused ? withOutline(holdingCaret) : undefined);

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

	if (!drawn || !frames) return null;

	/**
	 * Acts on a key pressed on the outline of the box at `box`, or on its
	 * `handle`: an arrow moves the box, or the handle's sides; Delete or
	 * Backspace removes it; the editor's keys for undo and redo undo and redo
	 * there; and Escape goes back to its words, or, during a drag, ends it.
	 */
	function actOnKey(event: KeyboardEvent<HTMLElement>, box: number, handle: Handle | undefined) {
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
			if (!event.repeat && remove(box)) ignoreRestOfPress(event.key);
			return;
		}
		const arrow = ARROWS[event.key];
		if (!arrow) return;
		event.preventDefault();
		const start = drawnBoxes(editor.view, slide);
		const startFrame = start?.frames[box];
		if (!start || !startFrame) return;
		const step = event.shiftKey ? NUDGE_WITH_SHIFT : NUDGE;
		const by = { dx: arrow.dx * step, dy: arrow.dy * step };
		const { frame } = handle
			? resizedFrame(startFrame, handle, by, NO_SNAP_LINES)
			: movedFrame(startFrame, by, NO_SNAP_LINES);
		const placing = placeBox(editor.state, slide.pos, box, frame, start.frames);
		if (placing) editor.view.dispatch(placing);
	}

	/**
	 * Removes the box at `box` from the slide, if it can be removed now, and
	 * puts the focus in the slide's words: its outline goes with it. Answers
	 * whether it removed it.
	 */
	function remove(box: number): boolean {
		const removing = removeBox(editor.state, slide.pos, box);
		if (!removing) return false;
		editor.view.dispatch(removing);
		editor.view.focus();
		return true;
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
					"--band-outside": `${BAND_OUTSIDE_PX}px`,
				} as CSSProperties
			}
		>
			{frames.map((frame, index) => {
				const role = roles[index];
				if (!role || !outlined[index] || (index !== editing && index !== hovered)) return null;
				return (
					<BoxOutline
						// A box has no lasting id, so its place is its key, which keeps a drag's element through a drag.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={index}
						box={index}
						frame={frame}
						name={BOX_NAMES[role]}
						editing={index === editing}
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
		</div>
	);
}

/** A drag under way of one of a slide's boxes. */
interface BoxDrag {
	/** The box being dragged, by its place on the slide. */
	box: number;
	/** Where the drag has the slide's boxes, and the lines the dragged one has snapped to, once it has moved. */
	moved?: { frames: readonly Frame[]; guides: readonly Guide[] };
	/** Ends the drag without writing it. */
	cancel: () => void;
}

/**
 * Dragging the boxes of `slide`, the slide on the stage, by their outlines:
 * the drag under way, if there is one, and how to start one from a press on
 * the outline of the box at `box`, or on its `handle`. The drag is the
 * pointer's wherever it goes, whatever becomes of the element pressed, and
 * keeps to its slide, `followed`, through anybody's changes. It ends,
 * unwritten, once the slide is gone, once the box it drags has no outline
 * (`outlined`), or once the outlines go.
 */
function useBoxDrag(
	editor: Editor,
	slide: PlacedSlide,
	followed: FollowedNode,
	outlined: readonly boolean[],
) {
	const [drag, setDrag] = useState<BoxDrag>();
	const cancelDrag = drag?.cancel;
	// Ends the drag under way when the outlines go. When a drag ends otherwise, this runs too, and
	// does nothing.
	useLayoutEffect(() => cancelDrag, [cancelDrag]);
	const boxGone = drag !== undefined && !outlined[drag.box];
	useEffect(() => {
		if (boxGone) cancelDrag?.();
	}, [boxGone, cancelDrag]);

	function startDrag(event: PointerEvent<HTMLElement>, box: number, handle: Handle | undefined) {
		if (event.button !== 0 || event.pointerType === "touch" || drag) return;
		const start = drawnBoxes(editor.view, slide);
		const startFrame = start?.frames[box];
		if (!start || !startFrame) return;
		event.preventDefault();
		const control = event.currentTarget;
		const { pointerId } = event;
		control.focus({ preventScroll: true });
		control.setPointerCapture(pointerId);
		const startFrames = start.frames;
		const lines = snapLinesAround(
			startFrames.filter((_, index) => index !== box && outlined[index]),
		);
		const from = pointOnSlide(start.area, event);
		let pointer: ClientPoint = { clientX: event.clientX, clientY: event.clientY };
		let arranged: Arranged | undefined;
		let ended = false;

		const cancel = () => end(false);
		/**
		 * Arranges the box by where the pointer is on the slide now, measured
		 * where the slide is drawn now, which moves under the pointer as the
		 * page scrolls.
		 */
		const follow = () => {
			const slidePos = whereFollowedNodeIs(editor.state.doc, followed);
			const area =
				slidePos === undefined
					? undefined
					: drawnSlideBody(editor.view, slidePos)?.getBoundingClientRect();
			if (slidePos === undefined || !area?.width) return end(false);
			const at = pointOnSlide(area, pointer);
			const by = { dx: at.x - from.x, dy: at.y - from.y };
			const movedPx = Math.hypot(by.dx, by.dy) * (area.width / SLIDE_WIDTH);
			if (!arranged && movedPx < DRAG_THRESHOLD_PX) return;
			arranged = handle
				? resizedFrame(startFrame, handle, by, lines)
				: movedFrame(startFrame, by, lines);
			const frames = withFrame(startFrames, box, arranged.frame);
			setDrag({ box, moved: { frames, guides: arranged.guides }, cancel });
			editor.view.dispatch(previewingBoxes(editor.state, { pos: slidePos, followed }, frames));
		};
		const move = (moving: globalThis.PointerEvent) => {
			if (moving.pointerId !== pointerId) return;
			pointer = { clientX: moving.clientX, clientY: moving.clientY };
			follow();
		};
		const release = (released: globalThis.PointerEvent) => {
			if (released.pointerId === pointerId) end(true);
		};
		const interrupted = (stopped: globalThis.PointerEvent) => {
			if (stopped.pointerId === pointerId) end(false);
		};
		function end(written: boolean) {
			if (ended) return;
			ended = true;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", interrupted);
			window.removeEventListener("scroll", follow, true);
			if (control.hasPointerCapture(pointerId)) control.releasePointerCapture(pointerId);
			setDrag(undefined);
			if (!arranged || editor.isDestroyed) return;
			const slidePos = whereFollowedNodeIs(editor.state.doc, followed);
			const placing =
				written && slidePos !== undefined
					? placeBox(editor.state, slidePos, box, arranged.frame, startFrames)
					: undefined;
			editor.view.dispatch(withoutBoxesPreview(placing ?? editor.state.tr));
		}
		// On the window, which outlasts the element pressed: it can go mid-drag, with its box.
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", interrupted);
		window.addEventListener("scroll", follow, { capture: true, passive: true });
		setDrag({ box, cancel });
	}

	return { drag, startDrag };
}

/**
 * One box's outline: the band along it that moves the box, and, while it is
 * being edited, the handles that resize it.
 */
function BoxOutline({
	box,
	frame,
	name,
	editing,
	onFocusChange,
	onDragStart,
	onKeyDown,
}: {
	/** The box, by its place on the slide. */
	box: number;
	frame: Frame;
	/** What the box is called, as `BOX_NAMES` says it. */
	name: string;
	editing: boolean;
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
			className="box-frame"
			data-editing={editing ? "" : undefined}
			{...{ [OUTLINED_BOX_ATTRIBUTE]: box }}
			style={frameStyle(frame)}
		>
			<button
				type="button"
				className="box-move"
				aria-label={`Move ${name}`}
				aria-keyshortcuts={OUTLINE_KEYS}
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
						aria-label={`Resize ${name} from the ${HANDLE_PLACES[handle].words}`}
						aria-keyshortcuts={OUTLINE_KEYS}
						style={HANDLE_PLACES[handle].style}
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

/** Where on a box's outline each handle sits, the pointer over it, and the words it is named with. */
const HANDLE_PLACES: Record<Handle, { style: CSSProperties; words: string }> = {
	"top-left": { style: { left: "0%", top: "0%", cursor: "nwse-resize" }, words: "top left" },
	top: { style: { left: "50%", top: "0%", cursor: "ns-resize" }, words: "top" },
	"top-right": { style: { left: "100%", top: "0%", cursor: "nesw-resize" }, words: "top right" },
	right: { style: { left: "100%", top: "50%", cursor: "ew-resize" }, words: "right" },
	"bottom-right": {
		style: { left: "100%", top: "100%", cursor: "nwse-resize" },
		words: "bottom right",
	},
	bottom: { style: { left: "50%", top: "100%", cursor: "ns-resize" }, words: "bottom" },
	"bottom-left": {
		style: { left: "0%", top: "100%", cursor: "nesw-resize" },
		words: "bottom left",
	},
	left: { style: { left: "0%", top: "50%", cursor: "ew-resize" }, words: "left" },
};

const percent = (fraction: number) => `${fraction * 100}%`;

/** Where a box is drawn over the slide, as parts of the slide's width and height. */
const frameStyle = ({ x, y, w, h }: Frame): CSSProperties => ({
	left: percent(x / SLIDE_WIDTH),
	top: percent(y / SLIDE_HEIGHT),
	width: percent(w / SLIDE_WIDTH),
	height: percent(h / SLIDE_HEIGHT),
});

const withFrame = (frames: readonly Frame[], box: number, frame: Frame) =>
	frames.map((each, index) => (index === box ? frame : each));

/** Where the pointer is in the window, as a pointer event gives it. */
interface ClientPoint {
	clientX: number;
	clientY: number;
}

/** Where the pointer at `point` is on a slide drawn at `area` in the window, in the slide's pixels. */
function pointOnSlide(area: DOMRect, { clientX, clientY }: ClientPoint) {
	const scale = area.width / SLIDE_WIDTH;
	return { x: (clientX - area.left) / scale, y: (clientY - area.top) / scale };
}

/** The slide's frame where it is drawn in the window, and where its boxes are on it. */
interface DrawnBoxes {
	area: DOMRect;
	frames: readonly Frame[];
}

/**
 * Where the boxes of `slide` are as the editor draws it now: where it places
 * them, or, on a slide its layout places, where the layout draws them, and
 * `REMOVED_BOX_FRAME` for one off the slide, which isn't drawn.
 */
function drawnBoxes(view: EditorView, slide: PlacedSlide): DrawnBoxes | undefined {
	const body = drawnSlideBody(view, slide.pos);
	if (!body) return undefined;
	const area = body.getBoundingClientRect();
	const placed = placementOf(slide.node);
	if (placed) return { area, frames: placed };
	const drawn = [...body.children].filter((child) => child.hasAttribute("data-slide-box"));
	const boxes = slide.node.child(0).children;
	if (drawn.length !== boxes.length) return undefined;
	return {
		area,
		frames: drawn.map((box, index) => {
			const node = boxes[index];
			return node && isRemovedBox(node)
				? REMOVED_BOX_FRAME
				: frameOfDrawnBox(box.getBoundingClientRect(), area);
		}),
	};
}

/** Where the slide on the stage is drawn in `stage`, by its frame's top left corner and width, and where its boxes are on it. */
interface DrawnSlide {
	left: number;
	top: number;
	width: number;
	frames: readonly Frame[];
}

/**
 * Where `slide` is drawn in `stage`, measured again whenever it changes or
 * anything on it changes size, as its text does when it steps down to fit.
 */
function useDrawnSlide(
	view: EditorView,
	slide: PlacedSlide,
	stage: RefObject<HTMLElement | null>,
): DrawnSlide | undefined {
	const [drawn, setDrawn] = useState<DrawnSlide>();
	const measure = useEffectEvent(() => {
		const holder = stage.current?.getBoundingClientRect();
		const boxes = drawnBoxes(view, slide);
		if (!holder || !boxes) return setDrawn(undefined);
		const now = {
			left: boxes.area.left - holder.left,
			top: boxes.area.top - holder.top,
			width: boxes.area.width,
			frames: boxes.frames,
		};
		setDrawn((before) => (before && sameDrawnSlide(before, now) ? before : now));
	});
	const { node, pos } = slide;
	// biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the slide changes.
	useLayoutEffect(() => measure(), [node, pos]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change to the slide draws it anew, whose boxes are then the ones to watch.
	useEffect(() => {
		const [holder, body] = [stage.current, drawnSlideBody(view, pos)];
		if (!holder || !body) return;
		const resized = new ResizeObserver(() => measure());
		for (const element of [holder, body, ...body.children]) resized.observe(element);
		return () => resized.disconnect();
	}, [view, stage, node, pos]);
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
 * The last of `frames`, the one drawn over any before it, whose box or band
 * is under the pointer at `event`, on a slide drawn at `area` in the window,
 * among the boxes `outlined` says have an outline.
 */
function boxUnder(
	frames: readonly Frame[],
	outlined: readonly boolean[],
	area: DOMRect,
	event: globalThis.PointerEvent,
): number | undefined {
	const reach = (BAND_OUTSIDE_PX * SLIDE_WIDTH) / area.width;
	const { x, y } = pointOnSlide(area, event);
	const under = frames.findLastIndex(
		(frame, index) =>
			outlined[index] &&
			x >= frame.x - reach &&
			x <= frame.x + frame.w + reach &&
			y >= frame.y - reach &&
			y <= frame.y + frame.h + reach,
	);
	return under < 0 ? undefined : under;
}

/**
 * Which of the editor's keys for undo and redo `event` is, if it is one:
 * ⌘Z on a Mac and Ctrl+Z elsewhere to undo, with Shift, or Y in place of Z,
 * to redo.
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
function editWordsOf(editor: Editor, slideIndex: number, box: number) {
	const { state, view } = editor;
	const slide = slidesOf(state.doc)[slideIndex];
	if (slide && boxAt(state.doc, state.selection.head, slideIndex) !== box) {
		let start: number | undefined;
		slide.node.child(0).forEach((_, offset, index) => {
			if (index === box) start = slide.pos + 2 + offset;
		});
		if (start === undefined) return;
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
