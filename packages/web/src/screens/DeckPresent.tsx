import { DOMSerializer } from "@tiptap/pm/model";
import { type Editor, useEditorState } from "@tiptap/react";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { asItReadsNow, proposedChangeOf, slidesOf } from "@/lib/deck.ts";
import { Kbd } from "@/ui/kbd.tsx";
import { SlideDrawing } from "./slide-drawing.tsx";

/**
 * A deck presented: one slide at a time, filling the screen at 16:9 on black,
 * with the controls in a pill under it that fades while the pointer rests.
 * It shows the deck as it reads now and as others change it: content
 * somebody proposes adding is not on the slides, what they propose removing
 * still is, and a slide proposed as new is passed over. It takes the whole
 * screen where the browser lets it, and covers the window where it doesn't.
 * Leaving it, `onExit` is told which slide it was on, by its place in the
 * deck being edited.
 */
export function DeckPresent({
	editor,
	title,
	startAt,
	onExit,
}: {
	editor: Editor;
	title: string;
	/** The slide to start at, by its place in the deck being edited. */
	startAt: number;
	onExit: (at: number) => void;
}) {
	const deck = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc });
	const slides = useMemo(() => asItReadsNow(deck).children, [deck]);
	// Which slide of the deck being edited each slide presented is, in order.
	const inDeck = useMemo(
		() =>
			slidesOf(deck)
				.filter(({ node }) => proposedChangeOf(node) !== "adding")
				.map(({ index }) => index),
		[deck],
	);
	const serializer = useMemo(() => DOMSerializer.fromSchema(editor.schema), [editor]);
	const [chosen, setChosen] = useState(() => inDeck.filter((index) => index < startAt).length);
	const at = Math.max(0, Math.min(chosen, slides.length - 1));
	const last = slides.length - 1;
	const slide = slides[at];
	const go = (to: number) => setChosen(Math.max(0, Math.min(to, last)));
	const exit = () => onExit(inDeck[at] ?? startAt);

	const screen = useRef<HTMLDivElement>(null);
	useFullScreen(screen, exit);
	const resting = useResting();

	function handleKey(event: KeyboardEvent) {
		// A focused control in the pill answers Enter and Space itself.
		const onControl = event.target instanceof HTMLButtonElement;
		const move = KEYS[event.key];
		if (event.key === "Escape") {
			// Handled here, so the stage the deck is open in doesn't take it for closing.
			event.preventDefault();
			exit();
		} else if (move && !(onControl && (event.key === " " || event.key === "Enter"))) {
			event.preventDefault();
			go(move === "first" ? 0 : move === "last" ? last : at + move);
		}
	}
	/** A click on the slide goes on to the next, and a link on it opens nothing. */
	function handleClick(event: MouseEvent) {
		if (!(event.target instanceof Element) || event.target.closest("[role=toolbar]")) return;
		event.preventDefault();
		go(at + 1);
	}

	return createPortal(
		<div
			ref={screen}
			role="dialog"
			aria-modal="true"
			aria-label={`Presenting ${title}`}
			tabIndex={-1}
			onKeyDown={handleKey}
			onClick={handleClick}
			onPointerMove={resting.wake}
			className={cn(
				"fixed inset-0 z-50 flex items-center justify-center bg-black outline-none",
				resting.resting && "cursor-none",
			)}
		>
			<div className="w-full" style={{ maxWidth: "calc(100dvh * 16 / 9)" }}>
				{slide && <SlideDrawing slide={slide} serializer={serializer} />}
			</div>
			<div
				role="toolbar"
				aria-label="Presenting"
				className={cn(
					"absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border-strong bg-panel p-1 text-foreground text-xs shadow-popover transition-opacity duration-300 focus-within:opacity-100",
					resting.resting && "pointer-events-none opacity-0",
				)}
			>
				<PillButton label="Previous slide" disabled={at === 0} onClick={() => go(at - 1)}>
					<ChevronLeft aria-hidden size={16} />
				</PillButton>
				<span aria-live="polite" className="min-w-11 text-center text-soft-foreground tabular-nums">
					{at + 1} / {slides.length}
				</span>
				<PillButton label="Next slide" disabled={at === last} onClick={() => go(at + 1)}>
					<ChevronRight aria-hidden size={16} />
				</PillButton>
				<span aria-hidden className="mx-1 h-4 w-px bg-border-strong" />
				<button
					type="button"
					onClick={exit}
					aria-keyshortcuts="Escape"
					className="focus-ring flex h-9 items-center gap-2 rounded-full pr-3.5 pl-3 font-medium transition-colors hover:bg-hover"
				>
					<X aria-hidden size={14} />
					Exit
					<Kbd>Esc</Kbd>
				</button>
			</div>
		</div>,
		document.body,
	);
}

/** What each key does while presenting: moves by a slide, or goes to the first or the last. */
const KEYS: Record<string, 1 | -1 | "first" | "last"> = {
	ArrowRight: 1,
	ArrowDown: 1,
	" ": 1,
	PageDown: 1,
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
	Home: "first",
	End: "last",
};

/** A round button of the pill. Its name is its only label: a tooltip couldn't show over the whole screen. */
function PillButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className="focus-ring grid size-9 place-items-center rounded-full text-foreground transition-colors hover:bg-hover disabled:text-disabled-foreground disabled:hover:bg-transparent"
		>
			{children}
		</button>
	);
}

/**
 * Takes the whole screen for `element` where the browser lets it, and calls
 * `onLeft` when the person leaves it another way than through the present
 * view, as with the browser's own Escape. Gives it back when the view goes.
 */
function useFullScreen(element: RefObject<HTMLElement | null>, onLeft: () => void) {
	const left = useRef(onLeft);
	useEffect(() => {
		left.current = onLeft;
	});
	useEffect(() => {
		const screen = element.current;
		if (!screen) return;
		screen.focus();
		let entered = false;
		const changed = () => {
			if (document.fullscreenElement === screen) entered = true;
			else if (entered) left.current();
		};
		document.addEventListener("fullscreenchange", changed);
		// Without it, or where it is refused, the view still covers the window.
		void screen.requestFullscreen?.().catch(() => {});
		return () => {
			document.removeEventListener("fullscreenchange", changed);
			if (document.fullscreenElement === screen) void document.exitFullscreen().catch(() => {});
		};
	}, [element]);
}

/** How long the pointer rests before the controls fade. */
const RESTING_MS = 2000;

/** Whether the pointer has rested a while, and `wake` to call when it moves. */
function useResting() {
	const [resting, setResting] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const wake = useCallback(() => {
		setResting(false);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setResting(true), RESTING_MS);
	}, []);
	useEffect(() => {
		wake();
		return () => clearTimeout(timer.current);
	}, [wake]);
	return { resting, wake };
}
