import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon, XIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { type Screenshot, screenshots } from "@/landing/media";
import { captureFor, ForVisitorOs, visitorOs } from "@/landing/visitor-os";

const ADVANCE_MILLISECONDS = 5000;
/** Narrow enough that a neighbour shows on each side at every width. */
const SLIDE_WIDTH = "min(76vw, 1040px)";
/** How many slides either side of the current one are drawn: the peeking one, and one beyond it to slide in. */
const DRAWN_EACH_SIDE = 2;
const SLIDE_GAP_PX = 24;
/** How far the pointer moves before a press becomes a drag rather than a click. */
const DRAG_START_PX = 6;
/** How much of a slide's width a drag must cover to move on to the next one. */
const DRAG_ADVANCE_SHARE = 0.15;

/** The slide at `position`, counting round the screenshots in either direction. */
function screenshotAt(position: number): number {
	return ((position % screenshots.length) + screenshots.length) % screenshots.length;
}

/**
 * The screenshots, one at a time in the middle with their neighbours peeking in
 * from each side. They go round in a loop, so there is always one either side.
 * It moves on every five seconds, except while the pointer or keyboard focus is
 * on it, or for visitors who ask for reduced motion.
 *
 * `position` counts every move and never wraps, so each drawn slide keeps its
 * key as it moves and slides rather than jumps.
 */
export function ScreenshotCarousel() {
	const reduceMotion = useReducedMotion();
	const [position, setPosition] = useState(0);
	const current = screenshotAt(position);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	// The enlarged screenshot is always the current one, so moving through it moves the carousel too.
	const [enlarged, setEnlarged] = useState(false);
	// How far the slides are dragged from where they rest, in pixels, while they're dragged.
	const [draggedPx, setDraggedPx] = useState<number>();
	const press = useRef<{ startX: number; dragging: boolean }>(undefined);
	// A drag ends with a click on whatever it was released over, which must not select or enlarge it.
	const draggedJustNow = useRef(false);
	const paused = hovered || focused || enlarged || draggedPx !== undefined || reduceMotion;

	useEffect(() => {
		if (paused) return;
		const interval = setInterval(() => setPosition((moved) => moved + 1), ADVANCE_MILLISECONDS);
		return () => clearInterval(interval);
	}, [paused]);

	/** Moves the shorter way round to the screenshot at `index`. */
	const show = (index: number) => {
		const ahead = screenshotAt(index - current);
		setPosition(position + (ahead <= screenshots.length / 2 ? ahead : ahead - screenshots.length));
	};
	/** Moves by as many slides as the drag covered, at least one once it covers a little of one, and lets go. */
	const endDrag = (slideWidthPx: number) => {
		const dragged = draggedPx ?? 0;
		press.current = undefined;
		setDraggedPx(undefined);
		if (Math.abs(dragged) < slideWidthPx * DRAG_ADVANCE_SHARE) return;
		const slides = Math.max(1, Math.round(Math.abs(dragged) / (slideWidthPx + SLIDE_GAP_PX)));
		setPosition((moved) => moved - Math.sign(dragged) * slides);
	};
	const drawn = Array.from(
		{ length: DRAWN_EACH_SIDE * 2 + 1 },
		(_, slot) => position - DRAWN_EACH_SIDE + slot,
	);

	return (
		<section
			aria-roledescription="carousel"
			aria-label="A look inside Sugabots"
			className="flex flex-col gap-8 overflow-hidden pt-40 sm:pt-[260px]"
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<div
				onPointerEnter={() => setHovered(true)}
				onPointerLeave={() => setHovered(false)}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					draggedJustNow.current = false;
					press.current = { startX: event.clientX, dragging: false };
				}}
				onPointerMove={(event) => {
					if (!press.current) return;
					const movedPx = event.clientX - press.current.startX;
					if (!press.current.dragging) {
						if (Math.abs(movedPx) < DRAG_START_PX) return;
						press.current.dragging = true;
						event.currentTarget.setPointerCapture(event.pointerId);
					}
					setDraggedPx(movedPx);
				}}
				onPointerUp={(event) => {
					if (press.current?.dragging) draggedJustNow.current = true;
					endDrag(event.currentTarget.offsetWidth);
				}}
				onPointerCancel={(event) => endDrag(event.currentTarget.offsetWidth)}
				onClickCapture={(event) => {
					if (!draggedJustNow.current) return;
					draggedJustNow.current = false;
					event.stopPropagation();
				}}
				// Sideways is the carousel's; up and down still scroll the page on a touch screen.
				className={cn(
					"relative mx-auto aspect-16/10 touch-pan-y select-none",
					draggedPx !== undefined && "cursor-grabbing",
				)}
				style={{ width: SLIDE_WIDTH }}
			>
				{drawn.map((slidePosition) => {
					const index = screenshotAt(slidePosition);
					const screenshot = screenshots[index];
					if (!screenshot) return null;
					return (
						<Slide
							key={slidePosition}
							screenshot={screenshot}
							label={`${index + 1} of ${screenshots.length}`}
							offset={slidePosition - position}
							draggedPx={draggedPx}
							onSelect={() => setPosition(slidePosition)}
							onEnlarge={() => setEnlarged(true)}
						/>
					);
				})}
			</div>
			<div className="flex flex-col items-center gap-1.5 px-8 text-center">
				<Captions current={current} />
				<div className="mt-3.5 flex gap-2">
					{screenshots.map((screenshot, index) => (
						<button
							key={screenshot.title}
							type="button"
							aria-label={`Show ${screenshot.title}`}
							aria-current={index === current}
							onClick={() => show(index)}
							// The visible bar is 4px tall; the padding gives it a target a finger can hit.
							className="group -my-2 cursor-pointer py-2 outline-none"
						>
							<span
								className={cn(
									"block h-1 rounded-xs transition-[width,background-color] duration-260 ease-landing group-focus-visible:ring-2 group-focus-visible:ring-landing-accent",
									index === current ? "w-7 bg-landing-text" : "w-2 bg-landing-rule",
								)}
							/>
						</button>
					))}
				</div>
			</div>
			{enlarged && (
				<EnlargedScreenshot
					current={current}
					onPrevious={() => setPosition((moved) => moved - 1)}
					onNext={() => setPosition((moved) => moved + 1)}
					onClose={() => setEnlarged(false)}
				/>
			)}
		</section>
	);
}

interface SlideProps {
	screenshot: Screenshot;
	label: string;
	/** Slides from the current one: negative to its left, positive to its right. */
	offset: number;
	/** How far the slides are dragged, while they are: they follow the pointer rather than easing. */
	draggedPx: number | undefined;
	onSelect: () => void;
	/** Shows the screenshot at full size, where its text can be read. */
	onEnlarge: () => void;
}

/**
 * One screenshot. The current one enlarges when clicked; the ones beside it
 * can be clicked to bring them in, and keyboard users move with the dots, so
 * only the current one takes focus.
 */
function Slide({ screenshot, label, offset, draggedPx, onSelect, onEnlarge }: SlideProps) {
	const isCurrent = offset === 0;
	return (
		// biome-ignore lint/a11y/useSemanticElements: the carousel pattern labels each slide as a group, and a fieldset is for form controls.
		<div
			role="group"
			aria-roledescription="slide"
			aria-label={`${label}: ${screenshot.title}`}
			aria-hidden={!isCurrent}
			onClick={isCurrent ? undefined : onSelect}
			className={cn(
				"absolute inset-0 transition-[opacity,transform] duration-380 ease-landing motion-reduce:transition-none",
				isCurrent ? "opacity-100" : "cursor-pointer opacity-50",
				draggedPx !== undefined && "transition-none",
			)}
			style={{
				transform: `translateX(calc(${offset} * (100% + ${SLIDE_GAP_PX}px) + ${draggedPx ?? 0}px))`,
			}}
		>
			<div className="relative size-full overflow-hidden rounded-[20px] border border-landing-frame bg-landing-card">
				{screenshot.image ? (
					<button
						type="button"
						tabIndex={isCurrent ? 0 : -1}
						aria-label={`Enlarge ${screenshot.title}`}
						onClick={isCurrent ? onEnlarge : undefined}
						className={cn(
							"group block size-full outline-none focus-visible:ring-2 focus-visible:ring-landing-accent focus-visible:ring-inset",
							isCurrent ? "cursor-zoom-in" : "pointer-events-none",
						)}
					>
						<ForVisitorOs>
							{(os) => (
								<img
									src={captureFor(screenshot.image ?? "", os)}
									alt={`${screenshot.title}: ${screenshot.description}`}
									width={2240}
									height={1400}
									loading="lazy"
									draggable={false}
									className="size-full object-cover object-top"
								/>
							)}
						</ForVisitorOs>
						<span className="pointer-events-none absolute right-3.5 bottom-3.5 grid size-9 place-items-center rounded-full border border-white/14 bg-landing-page/72 text-landing-text opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
							<Maximize2Icon className="size-4" />
						</span>
					</button>
				) : (
					<span className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-landing-faint">
						Screenshot: {screenshot.shows}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * A screenshot over the page at the size of the window, for reading, with its
 * caption under it. The arrows beside it, or the arrow keys, go round to the
 * screenshots either side. Escape, the close button or a click outside the
 * picture closes it.
 */
function EnlargedScreenshot({
	current,
	onPrevious,
	onNext,
	onClose,
}: {
	/** Which of the screenshots is enlarged. */
	current: number;
	onPrevious: () => void;
	onNext: () => void;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const screenshot = screenshots[current] ?? screenshots[0];
	return (
		<dialog
			ref={dialog}
			aria-label={`${current + 1} of ${screenshots.length}: ${screenshot.title}`}
			onClose={onClose}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") onPrevious();
				if (event.key === "ArrowRight") onNext();
			}}
			// A click on the backdrop lands on the dialog itself; one on the picture or its caption doesn't.
			onClick={(event) => {
				if (event.target === event.currentTarget) event.currentTarget.close();
			}}
			className="m-auto max-h-none max-w-none overflow-visible bg-transparent p-0 backdrop:bg-landing-page/88 backdrop:backdrop-blur-sm"
		>
			<figure className="m-0 flex flex-col items-center gap-4">
				{screenshot.image ? (
					<img
						src={captureFor(screenshot.image, visitorOs())}
						alt={`${screenshot.title}: ${screenshot.description}`}
						width={2240}
						height={1400}
						className="block h-auto max-h-[calc(92vh-5.5rem)] w-auto max-w-[min(96vw,calc(100vw-9rem))] rounded-xl"
					/>
				) : (
					<span className="grid aspect-16/10 w-[min(80vw,1040px)] place-items-center rounded-xl border border-landing-frame bg-landing-card p-6 text-center text-sm text-landing-faint">
						Screenshot: {screenshot.shows}
					</span>
				)}
				<figcaption className="px-4 text-center">
					<Captions current={current} />
				</figcaption>
			</figure>
			<button
				type="button"
				aria-label="Previous screenshot"
				onClick={onPrevious}
				className={cn(lightboxButton, "fixed top-1/2 left-4 -translate-y-1/2")}
			>
				<ChevronLeftIcon className="size-5" />
			</button>
			<button
				type="button"
				aria-label="Next screenshot"
				onClick={onNext}
				className={cn(lightboxButton, "fixed top-1/2 right-4 -translate-y-1/2")}
			>
				<ChevronRightIcon className="size-5" />
			</button>
			<button
				type="button"
				aria-label="Close"
				onClick={() => dialog.current?.close()}
				className={cn(lightboxButton, "fixed top-4 right-4")}
			>
				<XIcon className="size-5" />
			</button>
		</dialog>
	);
}

/** A round button over the enlarged screenshot: close, previous and next. */
const lightboxButton =
	"grid size-10 cursor-pointer place-items-center rounded-full border border-white/14 bg-landing-page/72 text-landing-text outline-none backdrop-blur-sm hover:bg-landing-button focus-visible:ring-2 focus-visible:ring-landing-accent";

/**
 * The screenshots' titles and descriptions, the current one shown. Every
 * caption sits in the same cell, so the cell is always as tall as the
 * longest: a two-line description never moves what is around it.
 */
function Captions({ current }: { current: number }) {
	return (
		<div className="grid max-w-[560px]">
			{screenshots.map((screenshot, index) => (
				<div
					key={screenshot.title}
					aria-hidden={index !== current}
					className={cn(
						"col-start-1 row-start-1 flex flex-col items-center gap-1.5",
						index === current ? "visible" : "invisible",
					)}
				>
					<span className="text-lg font-semibold text-landing-text">{screenshot.title}</span>
					<span className="text-[15.5px]/[1.5] text-pretty text-landing-muted">
						{screenshot.description}
					</span>
				</div>
			))}
		</div>
	);
}
