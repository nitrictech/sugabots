import { Popover } from "@base-ui/react/popover";
import { SLIDE_LAYOUTS, type SlideLayout } from "@sugabots/contracts/slide-layouts";
import { cn } from "cn";
import { RotateCcw } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { LAYOUT_NAMES } from "@/lib/deck.ts";

/**
 * The layouts a slide can have, each drawn as a sketch of where its parts
 * go, opened from `children`, the button that opens it. It is how a new
 * slide's layout is chosen, under `heading` "New slide", and how a slide's
 * is changed, under "Change layout", with the `current` one ringed. While
 * `unavailable` says why no layout can be chosen, it says that instead.
 * Given `onReset`, it ends with a row that puts the boxes the slide's layout
 * places back where it places them, even while no layout can be chosen.
 */
export function LayoutPicker({
	heading,
	current,
	unavailable,
	onPick,
	onReset,
	label,
	className,
	children,
}: {
	heading: string;
	current?: SlideLayout;
	unavailable?: string;
	onPick: (layout: SlideLayout) => void;
	/** Resets the slide's layout, for a slide whose layout's boxes have moved; `undefined` offers no reset. */
	onReset?: () => void;
	/** Names the button for assistive technology, when its own words don't. */
	label?: string;
	/** The button's classes. */
	className: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger aria-label={label} className={className}>
				{children}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
					<Popover.Popup className="flex w-118 max-w-(--available-width) flex-col gap-1.5 rounded-xl border border-border-strong bg-panel p-2.5 text-foreground shadow-popover outline-none">
						<Popover.Title className="m-0 px-1.5 pt-1 pb-0.5 font-normal text-subtle-foreground text-xs">
							{heading}
						</Popover.Title>
						{unavailable ? (
							<p className="m-0 px-1.5 pb-1.5 text-soft-foreground text-xs">{unavailable}</p>
						) : (
							<div className="grid grid-cols-3 gap-1">
								{SLIDE_LAYOUTS.map((layout) => (
									<button
										key={layout}
										type="button"
										aria-current={layout === current ? "true" : undefined}
										onClick={() => {
											setOpen(false);
											onPick(layout);
										}}
										className={cn(
											"focus-ring flex flex-col gap-1.5 rounded-lg p-1.5 text-left text-soft-foreground text-xs transition-colors hover:bg-hover",
											layout === current && "bg-hover",
										)}
									>
										<LayoutSketch layout={layout} current={layout === current} />
										{LAYOUT_NAMES[layout]}
									</button>
								))}
							</div>
						)}
						{onReset && (
							<>
								<hr className="-mx-2.5 border-border" />
								<button
									type="button"
									onClick={() => {
										setOpen(false);
										onReset();
									}}
									className="focus-ring flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-hover"
								>
									<RotateCcw aria-hidden size={16} className="shrink-0 text-soft-foreground" />
									<span className="flex flex-col gap-0.5">
										<span className="text-foreground">Reset layout</span>
										<span className="text-subtle-foreground">
											Put this layout's boxes back where it places them.
										</span>
									</span>
								</button>
							</>
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** A slide of `layout` drawn as bars where its words go, a block where its image goes, and a grid for its table. */
function LayoutSketch({ layout, current }: { layout: SlideLayout; current: boolean }) {
	const { arrangement, parts } = SKETCHES[layout];
	return (
		<span
			aria-hidden
			style={arrangement}
			className={cn(
				"box-border flex aspect-video w-full flex-col rounded-md border bg-slide-background",
				current ? "border-slide-accent" : "border-border-strong",
			)}
		>
			{parts}
		</span>
	);
}

/** How strongly a bar of a sketch is drawn: a title's, a line of text's, a bullet's, or the accent's. */
type Tone = "title" | "text" | "bullet" | "accent";

const TONES: Record<Tone, string> = {
	title: "bg-soft-foreground",
	text: "bg-disabled-foreground",
	bullet: "bg-subtle-foreground",
	accent: "bg-slide-accent",
};

/** A bar of a sketch, `width` across its row and `height` pixels tall. */
function Bar({
	width,
	height,
	tone,
	style,
}: {
	width: string;
	height: number;
	tone: Tone;
	style?: CSSProperties;
}) {
	return (
		<span
			style={{ width, height, borderRadius: SKETCH_RADIUS_PX, ...style }}
			className={cn("block shrink-0", TONES[tone])}
		/>
	);
}

const SKETCH_RADIUS_PX = 2;

/** A bulleted line of a sketch. */
const Bullet = ({ width }: { width: string }) => (
	<span className="flex items-center" style={{ gap: 5 }}>
		<span className="block size-1 shrink-0 rounded-full bg-subtle-foreground" />
		<Bar width={width} height={4} tone="text" />
	</span>
);

/** Lines of a sketch's column, as wide as `widths` say. */
const Lines = ({ widths }: { widths: string[] }) => (
	<span className="flex flex-col" style={{ gap: 5 }}>
		{widths.map((width, index) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed and never reorder.
			<Bar key={index} width={width} height={4} tone="text" />
		))}
	</span>
);

/** The table a sketch draws: three columns of three rows, the first its header. */
const TABLE_COLUMNS = 3;
const TABLE_CELLS = Array.from({ length: TABLE_COLUMNS * 3 }, (_, cell) => cell);

/** Where each layout's parts go, as the design sketches them: how the sketch arranges them, and the parts. */
const SKETCHES: Record<SlideLayout, { arrangement: CSSProperties; parts: ReactNode }> = {
	/** No parts at all, for boxes put anywhere. */
	blank: { arrangement: {}, parts: null },
	title: {
		arrangement: { padding: "10%", justifyContent: "center", gap: 6 },
		parts: (
			<>
				<Bar width="70%" height={9} tone="title" />
				<Bar width="45%" height={4} tone="text" />
			</>
		),
	},
	bullets: {
		arrangement: { padding: "10%", gap: 6 },
		parts: (
			<>
				<Bar width="40%" height={6} tone="title" style={{ marginBottom: 3 }} />
				<Bullet width="72%" />
				<Bullet width="84%" />
				<Bullet width="60%" />
			</>
		),
	},
	columns: {
		arrangement: { padding: "10%", gap: 8 },
		parts: (
			<>
				<Bar width="55%" height={6} tone="title" />
				<span className="grid grid-cols-2" style={{ gap: 10 }}>
					<Lines widths={["100%", "85%", "65%"]} />
					<Lines widths={["100%", "75%", "90%"]} />
				</span>
			</>
		),
	},
	image: {
		arrangement: {
			padding: "10%",
			display: "grid",
			gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
			gap: 10,
			alignItems: "center",
		},
		parts: (
			<>
				<span className="flex flex-col" style={{ gap: 5 }}>
					<Bar width="90%" height={6} tone="title" style={{ marginBottom: 2 }} />
					<Bar width="100%" height={4} tone="text" />
					<Bar width="70%" height={4} tone="text" />
				</span>
				<span className="block self-stretch bg-slide-rule" style={{ borderRadius: 3 }} />
			</>
		),
	},
	section: {
		arrangement: { padding: "10%", justifyContent: "flex-end", gap: 5 },
		parts: (
			<>
				<Bar width="14%" height={3} tone="accent" />
				<Bar width="22%" height={4} tone="text" />
				<Bar width="55%" height={10} tone="title" />
			</>
		),
	},
	quote: {
		arrangement: { padding: "10% 16%", justifyContent: "center", gap: 5 },
		parts: (
			<>
				<Bar width="100%" height={7} tone="title" />
				<Bar width="70%" height={7} tone="title" />
				<Bar width="35%" height={4} tone="text" style={{ marginTop: 4 }} />
			</>
		),
	},
	table: {
		arrangement: { padding: "10%", gap: 7 },
		parts: (
			<>
				<Bar width="45%" height={6} tone="title" />
				<span
					className="grid flex-1 grid-cols-3 grid-rows-3 overflow-hidden border border-border-dashed bg-border-dashed"
					style={{ gap: 1, borderRadius: 3 }}
				>
					{TABLE_CELLS.map((cell) => (
						<span
							key={cell}
							className={cell < TABLE_COLUMNS ? "bg-hover-strong" : "bg-slide-background"}
						/>
					))}
				</span>
			</>
		),
	},
};
