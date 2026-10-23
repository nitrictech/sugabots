import { cn } from "cn";
import {
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { ApprovalDemo, HandoffDemo, ModelsDemo, ThreadDemo } from "@/landing/card-demos";
import { SectionHeading } from "@/landing/section-heading";
import { siteColumn } from "@/layout";

interface Feature {
	title: string;
	body: string;
	Demo: ComponentType;
	/** The line over it while it's open: one of the logo's four colours, in the logo's order. */
	bar: string;
}

const features: readonly [Feature, ...Feature[]] = [
	{
		title: "Everyone has the context.",
		body: "See what was asked, add information, and pick up where someone else left off.",
		Demo: ThreadDemo,
		bar: "bg-landing-logo-green",
	},
	{
		title: "You can follow the work.",
		body: "See tool calls, results, and exchanges between bots.",
		Demo: ApprovalDemo,
		bar: "bg-landing-logo-blue",
	},
	{
		title: "Every handoff is visible.",
		body: "When a bot needs help, it asks another bot on the team. Follow the whole exchange, including what it asked, what came back, and what happens next.",
		Demo: HandoffDemo,
		bar: "bg-landing-logo-red",
	},
	{
		title: "You choose what powers each bot.",
		body: "Give each bot the model that suits its job. Use your ChatGPT or SuperGrok subscription, bring API keys, or run local models with Ollama. Mix and match within the same team.",
		Demo: ModelsDemo,
		bar: "bg-landing-logo-orange",
	},
];

/** A window the section pins in while scrolling opens each feature in turn: the `pinned:` variant in styles.css. */
const PINNING_QUERY = "(min-width: 64rem) and (min-height: 44rem)";

/**
 * "AI workspace for every team": the features as a list, one open at a time,
 * beside a demo of the open one in the app's own chat. In a big enough window
 * the whole section pins in place, centred, and scrolling through it opens
 * each feature in turn; picking one scrolls to its turn. Otherwise picking one
 * opens it, and on phones its demo sits under it.
 */
export function WorkspaceSection() {
	const [open, setOpen] = useState(0);
	const ids = useId();
	const track = useRef<HTMLDivElement>(null);
	const pinned = useRef<HTMLDivElement>(null);
	const [pinnedHeight, setPinnedHeight] = useState(0);

	// Its height, so the CSS can pin it centred in the space under the header.
	useEffect(() => {
		if (!pinned.current) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setPinnedHeight(entry.borderBoxSize[0]?.blockSize ?? 0);
		});
		observer.observe(pinned.current);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const pinning = window.matchMedia(PINNING_QUERY);
		let frame = 0;
		const followScroll = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (!pinning.matches || !track.current || !pinned.current) return;
				setOpen(featureAt(scrollProgress(track.current, pinned.current)));
			});
		};
		followScroll();
		window.addEventListener("scroll", followScroll, { passive: true });
		pinning.addEventListener("change", followScroll);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", followScroll);
			pinning.removeEventListener("change", followScroll);
		};
	}, []);

	/** While the section pins, scrolls to the middle of the feature's turn, which opens it; otherwise opens it. */
	const pick = (index: number) => {
		if (!window.matchMedia(PINNING_QUERY).matches || !track.current || !pinned.current) {
			setOpen(index);
			return;
		}
		const turnMiddle =
			((index + 0.5) / features.length) * scrollRange(track.current, pinned.current);
		const pinnedFrom =
			track.current.getBoundingClientRect().top + window.scrollY - pinnedOffset(pinned.current);
		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		window.scrollTo({ top: pinnedFrom + turnMiddle, behavior: reduceMotion ? "auto" : "smooth" });
	};

	return (
		<section className={cn(siteColumn, "pt-[260px]")}>
			{/* The stretch of scrolling the section stays pinned for: a turn per feature. */}
			<div ref={track} className="pinned:h-[320vh]">
				{/* Pinned centred in the space under the header, and only as tall as its content, so the next section follows at the usual distance. */}
				<div
					ref={pinned}
					style={{ "--pinned-height": `${pinnedHeight}px` } as CSSProperties}
					className="flex flex-col gap-16 pinned:sticky pinned:top-[max(var(--site-header-height),calc((100svh+var(--site-header-height)-var(--pinned-height))/2))] pinned:gap-12"
				>
					<SectionHeading
						title="AI workspace for every team"
						lede="Most AI chats are you and a bot. Sugabots is your team and your bots, with one history."
					/>
					{/* A steady height while pinned, so opening a longer feature doesn't move the heading. */}
					<div className="grid grid-cols-[minmax(0,1fr)] items-start gap-10 pinned:min-h-[400px] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-20">
						{/* Every demo is drawn, stacked, and the open one fades in over the last, so a switch never flashes. */}
						<DemoStage className="hidden lg:grid">
							{features.map(({ title, Demo }, index) => (
								<DemoFrame
									key={title}
									inert={index !== open}
									className={cn(
										"col-start-1 row-start-1 transition-[opacity,translate] duration-500 ease-landing motion-reduce:transition-none",
										index === open
											? "translate-y-0 opacity-100"
											: "pointer-events-none translate-y-1.5 opacity-0",
									)}
								>
									<Demo />
								</DemoFrame>
							))}
						</DemoStage>
						<div className="flex flex-col">
							{features.map((feature, index) => {
								const isOpen = index === open;
								const panel = `${ids}-${index}`;
								return (
									<div key={feature.title} className="relative border-t border-landing-rule">
										{/* The open feature's line, drawn over the divider. */}
										<span
											aria-hidden
											className={cn(
												"absolute inset-x-0 -top-px h-0.5 transition-opacity duration-300",
												feature.bar,
												isOpen ? "opacity-100" : "opacity-0",
											)}
										/>
										<h3>
											<button
												type="button"
												aria-expanded={isOpen}
												aria-controls={panel}
												onClick={() => pick(index)}
												className={cn(
													"w-full cursor-pointer py-5 text-left text-[21px]/[1.25] font-semibold tracking-[-0.01em] transition-colors outline-none focus-visible:text-landing-text",
													isOpen
														? "text-landing-text"
														: "text-landing-muted hover:text-landing-text",
												)}
											>
												{feature.title}
											</button>
										</h3>
										{/* Slides open and shut, so the features below it move rather than jump. */}
										<div
											id={panel}
											inert={!isOpen}
											className={cn(
												"grid transition-[grid-template-rows] duration-300 ease-landing motion-reduce:transition-none",
												isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
											)}
										>
											<div className="min-h-0 overflow-hidden">
												<div className="flex flex-col gap-6 pb-7">
													<p className="max-w-md text-[15.5px]/[1.6] text-pretty text-landing-muted">
														{feature.body}
													</p>
													{isOpen && (
														<DemoStage className="lg:hidden">
															<DemoFrame>
																<feature.Demo />
															</DemoFrame>
														</DemoStage>
													)}
												</div>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

/** How far below the top of the screen the section pins, as its CSS sets it. */
function pinnedOffset(pinned: HTMLElement) {
	return Number.parseFloat(getComputedStyle(pinned).top);
}

/** How far the page scrolls while the section stays pinned. */
function scrollRange(track: HTMLElement, pinned: HTMLElement) {
	return track.offsetHeight - pinned.offsetHeight;
}

/** How far through its pinned stretch the page has scrolled, from 0 to 1. */
function scrollProgress(track: HTMLElement, pinned: HTMLElement) {
	const scrolled = pinnedOffset(pinned) - track.getBoundingClientRect().top;
	return Math.min(1, Math.max(0, scrolled / scrollRange(track, pinned)));
}

/** The feature whose turn `progress` falls in. */
function featureAt(progress: number) {
	return Math.min(features.length - 1, Math.floor(progress * features.length));
}

/** Where a demo sits, at the top of its column. The column may narrow below a demo's widest line, so the demo truncates rather than spills over the edge. */
function DemoStage({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn("grid grid-cols-[minmax(0,1fr)] items-start", className)}>{children}</div>
	);
}

/** One demo on the stage, at the width of an app window, lifted off the panel by its shadow. */
function DemoFrame({
	className,
	inert,
	children,
}: {
	className?: string;
	inert?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			inert={inert}
			className={cn(
				"w-full min-w-0 max-w-[520px] [&>*]:shadow-[0_24px_60px_rgba(0,0,0,0.45)]",
				className,
			)}
		>
			{children}
		</div>
	);
}
