import { cn } from "cn";
import { Maximize2Icon, XIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { type Screenshot, screenshots } from "@/landing/media";
import { captureFor, ForVisitorOs, visitorOs } from "@/landing/visitor-os";

const ADVANCE_MILLISECONDS = 5000;
/** Narrow enough that a neighbour shows on each side at every width. */
const SLIDE_WIDTH = "min(76vw, 1040px)";
/** How many slides either side of the current one are drawn: the peeking one, and one beyond it to slide in. */
const DRAWN_EACH_SIDE = 2;
const SLIDE_GAP = "24px";

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
	const [enlarged, setEnlarged] = useState<Screenshot>();
	const paused = hovered || focused || enlarged !== undefined || reduceMotion;

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
				className="relative mx-auto aspect-16/10"
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
							onSelect={() => setPosition(slidePosition)}
							onEnlarge={() => setEnlarged(screenshot)}
						/>
					);
				})}
			</div>
			<div className="flex flex-col items-center gap-1.5 px-8 text-center">
				{/*
				 * Every caption sits in the same cell, the current one shown, so the cell is
				 * always as tall as the longest: a two-line description never moves the page.
				 */}
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
			{enlarged?.image && (
				<EnlargedScreenshot
					screenshot={enlarged}
					image={enlarged.image}
					onClose={() => setEnlarged(undefined)}
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
	onSelect: () => void;
	/** Shows the screenshot at full size, where its text can be read. */
	onEnlarge: () => void;
}

/**
 * One screenshot. The current one enlarges when clicked; the ones beside it
 * can be clicked to bring them in, and keyboard users move with the dots, so
 * only the current one takes focus.
 */
function Slide({ screenshot, label, offset, onSelect, onEnlarge }: SlideProps) {
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
			)}
			style={{ transform: `translateX(calc(${offset} * (100% + ${SLIDE_GAP})))` }}
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
 * A screenshot over the page at the size of the window, for reading. Escape,
 * the close button or a click outside the picture closes it.
 */
function EnlargedScreenshot({
	screenshot,
	image,
	onClose,
}: {
	screenshot: Screenshot;
	image: string;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the click is on the backdrop; from the keyboard, Escape and the close button do the same.
		<dialog
			ref={dialog}
			aria-label={screenshot.title}
			onClose={onClose}
			// A click on the backdrop lands on the dialog itself; one on the picture doesn't.
			onClick={(event) => {
				if (event.target === event.currentTarget) event.currentTarget.close();
			}}
			className="m-auto max-h-none max-w-none overflow-visible bg-transparent p-0 backdrop:bg-landing-page/88 backdrop:backdrop-blur-sm"
		>
			<img
				src={captureFor(image, visitorOs())}
				alt={`${screenshot.title}: ${screenshot.description}`}
				width={2240}
				height={1400}
				className="block h-auto max-h-[92vh] w-auto max-w-[96vw] rounded-xl"
			/>
			<button
				type="button"
				aria-label="Close"
				onClick={() => dialog.current?.close()}
				className="fixed top-4 right-4 grid size-10 cursor-pointer place-items-center rounded-full border border-white/14 bg-landing-page/72 text-landing-text outline-none backdrop-blur-sm hover:bg-landing-button focus-visible:ring-2 focus-visible:ring-landing-accent"
			>
				<XIcon className="size-5" />
			</button>
		</dialog>
	);
}
