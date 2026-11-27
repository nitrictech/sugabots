import { deckFromHtml } from "@sugabots/contracts/deck-html";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { layoutOf } from "@sugabots/contracts/live-slides";
import { getSchema } from "@tiptap/core";
import { DOMSerializer, type Node } from "@tiptap/pm/model";
import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { LAYOUT_NAMES } from "@/lib/deck.ts";
import { revenue } from "@/shell/story-fixtures.ts";
import { DRAWN_BOX, SlideDrawing } from "./slide-drawing.tsx";

/** The deck the slides are from, which keeps the image its image slide shows. */
const DECK = { podId: revenue.id, artifactId: "0199a3a0-0000-7000-8000-0000000000f3" };

const chartIds = artifactImageIds({ ...DECK, imageId: "c".repeat(64) });
if (!chartIds) throw new Error("The chart's ids are not of the form an image's address holds");

/** The chart the deck keeps, written into the page as an image, so the stories fetch nothing. */
const CHART_IMAGE = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#eef2ff"/><rect x="40" y="44" width="60" height="216" rx="6" fill="#2563eb"/><rect x="125" y="109" width="60" height="151" rx="6" fill="#2563eb"/><rect x="210" y="186" width="60" height="74" rx="6" fill="#2563eb"/><rect x="295" y="228" width="60" height="32" rx="6" fill="#2563eb"/></svg>',
)}`;

const serializer = DOMSerializer.fromSchema(
	getSchema(
		liveDocumentExtensions({
			kind: "slides",
			undo: true,
			ownImages: { artifact: DECK, source: () => CHART_IMAGE },
		}),
	),
);

/** A slide of `layout` holding `boxes`, as a deck's HTML writes it. */
const slideHtml = (layout: string, ...boxes: string[]) =>
	`<section data-slide data-layout="${layout}"><div data-slide-body>${boxes.join("")}</div></section>`;

/**
 * A box for `role` holding `html`, where its layout places it unless `style`
 * says where, its blocks at the edge `align` says.
 */
const box = (
	role: string,
	html: string,
	{ style, align }: { style?: string; align?: string } = {},
) =>
	`<div data-slide-box data-role="${role}"${align ? ` data-vertical-align="${align}"` : ""}${style ? ` style="${style}"` : ""}>${html}</div>`;

/** The style of a box framed `x` across and `y` down, `width` wide and `height` tall, in a slide's pixels. */
const at = (x: number, y: number, width: number, height: number) =>
	`left: ${x}px; top: ${y}px; width: ${width}px; height: ${height}px`;

const list = (...items: string[]) =>
	`<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`;

const TITLE = slideHtml(
	"title",
	box("title", "<h1>Q4 outreach plan</h1>", { align: "bottom" }),
	box("subtitle", "<p>Growth Desk, October 2026</p>"),
);

const GOALS_TITLE = box("title", "<h2>Goals</h2>");
const GOALS_LIST = list(
	"Book 40 discovery calls with mid-market accounts",
	"Reactivate the 12 stalled Proposal-stage deals",
	"Publish the new pricing page before December",
);
const GOALS = slideHtml("bullets", GOALS_TITLE, box("body", GOALS_LIST));

const PEOPLE = `<h3>People</h3>${list("Type in the deck together", "Accept or undo suggestions", "Present from any slide")}`;
const BOTS = `<h3>Bots</h3>${list("Suggest edits when asked", "Draft new slides", "Read the speaker's notes")}`;

/** The slide of two columns, its boxes at `frames` when given, in order, and where its layout places them otherwise. */
const peopleAndBots = (frames: string[] = []) =>
	slideHtml(
		"columns",
		box("title", "<h2>People and bots</h2>", { style: frames[0] }),
		box("leftColumn", PEOPLE, { style: frames[1] }),
		box("rightColumn", BOTS, { style: frames[2] }),
	);

const PIPELINE = slideHtml(
	"image",
	box("title", "<h2>Pipeline by stage</h2>", { align: "bottom" }),
	box("text", "<p>Leads doubled since July, and twice as many reach a proposal.</p>"),
	box(
		"image",
		`<p><img alt="Deals at each stage, from lead to won" data-address="${artifactImageAddress(chartIds)}"></p>`,
		{ align: "middle" },
	),
);

const PART_TWO_TITLE = box("title", "<h2>What we build next</h2>", { align: "bottom" });
const PART_TWO = slideHtml(
	"section",
	box("label", "<p>Part 2</p>", { align: "bottom" }),
	PART_TWO_TITLE,
);

const QUOTE = slideHtml(
	"quote",
	box("quote", "<blockquote><p>Ship the small thing first, then listen.</p></blockquote>", {
		align: "bottom",
	}),
	box("attribution", "<p>The growth team's rule for Q4</p>"),
);

const RISKS = slideHtml(
	"table",
	box("title", "<h2>Risks</h2>"),
	box(
		"table",
		"<table><tbody><tr><th><p>Risk</p></th><th><p>Owner</p></th></tr><tr><td><p>Holiday slowdown in December</p></td><td><p>Growth Desk</p></td></tr><tr><td><p>Pricing page still in review</p></td><td><p>Kim</p></td></tr></tbody></table>",
	),
);

/** Reads a deck's HTML inert, as the app does. */
const readHtml = new DOMParser();

/** The one slide `html`, a deck's HTML, says. */
const slideOf = (html: string): Node => deckFromHtml(html, readHtml).child(0);

/**
 * The step at which the slide drawn in `figure` draws its text, as a part of
 * its full size: "1" at full size, less once stepped down (see `fitSlideText`).
 */
const textStepOf = (figure: HTMLElement) =>
	figure.querySelector<HTMLElement>("[data-slide]")?.style.getPropertyValue("--slide-fit");

/** The drawn box of a slide that `element` is in. */
function drawnBoxOf(element: HTMLElement): HTMLElement {
	const drawn = element.closest<HTMLElement>(DRAWN_BOX);
	if (!drawn) throw new Error("The element is in no box of the slide");
	return drawn;
}

/** `slide` drawn read only, in a figure named `label`, which says what state the story shows. */
function DrawnSlide({ slide, label }: { slide: Node; label: string }) {
	return (
		<figure aria-label={label} className="m-0 w-full max-w-160">
			<SlideDrawing
				slide={slide}
				serializer={serializer}
				className="overflow-hidden rounded-lg ring-1 ring-border-strong"
			/>
		</figure>
	);
}

const meta = preview.meta({
	title: "Product/SlideDrawing",
	tags: ["ai-generated"],
});

const EVERY_LAYOUT = [TITLE, GOALS, peopleAndBots(), PIPELINE, PART_TWO, QUOTE, RISKS].map(slideOf);

/**
 * A slide of each layout, its boxes where the layout places them, as a deck
 * a bot writes is drawn in the strip of slides, in present mode and wherever
 * the deck is only read.
 */
export const EveryLayout = meta.story({
	render: () => (
		<ul className="m-0 grid max-w-240 list-none grid-cols-2 gap-6 p-0 max-md:grid-cols-1">
			{EVERY_LAYOUT.map((slide) => {
				const name = LAYOUT_NAMES[layoutOf(slide)];
				return (
					<li key={name}>
						<figure className="m-0 flex flex-col gap-2">
							<SlideDrawing
								slide={slide}
								serializer={serializer}
								className="overflow-hidden rounded-lg ring-1 ring-border-strong"
							/>
							<figcaption className="text-muted-foreground text-xs">{name}</figcaption>
						</figure>
					</li>
				);
			})}
		</ul>
	),
});

/** The same slides in the light theme. */
export const EveryLayoutInLight = meta.story({
	...EveryLayout.input,
	globals: { theme: "light" },
});

const GOALS_PLACED = slideOf(
	slideHtml(
		"bullets",
		box("title", "<h2>Goals</h2>", { style: at(80, 64, 280, 160) }),
		box("body", GOALS_LIST, { style: at(400, 64, 480, 412) }),
	),
);

/** A slide whose boxes somebody placed by hand: its title moved beside its bullets, not over them. */
export const PlacedByHand = meta.story({
	render: () => <DrawnSlide slide={GOALS_PLACED} label="Goals, placed by hand" />,
	play: async ({ canvas }) => {
		const slide = within(canvas.getByRole("figure", { name: "Goals, placed by hand" }));
		const title = slide.getByRole("heading", { name: "Goals" });
		const bullets = slide.getByRole("list");
		await expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
			bullets.getBoundingClientRect().left,
		);
	},
});

/** Scaled as one piece, a slide placed by hand keeps where its boxes are at a phone's width. */
export const PlacedByHandOnAPhone = meta.story({
	...PlacedByHand.input,
	globals: { viewport: { value: "mobile1" }, theme: "light" },
});

/**
 * A two-column slide with its left column deleted. The right column stays on
 * the right, where it was.
 */
export const ColumnDeleted = meta.story({
	render: () => (
		<DrawnSlide
			slide={slideOf(
				slideHtml("columns", box("title", "<h2>People and bots</h2>"), box("rightColumn", BOTS)),
			)}
			label="People and bots, its left column deleted"
		/>
	),
	play: async ({ canvas }) => {
		const figure = canvas.getByRole("figure", { name: "People and bots, its left column deleted" });
		const slide = within(figure);
		await expect(slide.queryByRole("heading", { name: "People" })).toBeNull();
		await expect(slide.queryByText("Type in the deck together")).toBeNull();
		const rightColumn = slide.getByRole("heading", { name: "Bots" });
		await expect(rightColumn).toBeVisible();
		const drawn = figure.getBoundingClientRect();
		await expect(rightColumn.getBoundingClientRect().left).toBeGreaterThan(
			drawn.left + drawn.width / 2,
		);
	},
});

/** A section break with its label deleted, which takes the accent drawn over the label with it. */
export const SectionLabelDeleted = meta.story({
	render: () => (
		<DrawnSlide
			slide={slideOf(slideHtml("section", PART_TWO_TITLE))}
			label="Part 2, its label deleted"
		/>
	),
	play: async ({ canvas }) => {
		const figure = canvas.getByRole("figure", { name: "Part 2, its label deleted" });
		const slide = within(figure);
		await expect(slide.queryByText("Part 2")).toBeNull();
		await expect(slide.getByRole("heading", { name: "What we build next" })).toBeVisible();
		await expect(figure.querySelector('[data-role="label"]')).toBeNull();
	},
});

const RUNS_PAST_ITS_BOX = slideOf(
	peopleAndBots([at(80, 64, 800, 64), at(80, 160, 380, 80), at(500, 160, 380, 316)]),
);

/**
 * A slide whose left column holds more than its box: what runs past the foot
 * of the box is drawn under it, at full size, as nothing on the slide is in
 * its way.
 */
export const TextRunsPastItsBox = meta.story({
	render: () => (
		<DrawnSlide slide={RUNS_PAST_ITS_BOX} label="People and bots, its left column too short" />
	),
	play: async ({ canvas }) => {
		const figure = canvas.getByRole("figure", {
			name: "People and bots, its left column too short",
		});
		const lastLine = within(figure).getByText("Present from any slide");
		await waitFor(() =>
			expect(lastLine.getBoundingClientRect().bottom).toBeGreaterThan(
				drawnBoxOf(lastLine).getBoundingClientRect().bottom,
			),
		);
		await waitFor(() => expect(textStepOf(figure)).toBe("1"));
	},
});

const RUNS_OUT_OF_ROOM = slideOf(
	peopleAndBots([at(80, 64, 800, 64), at(80, 160, 380, 80), at(80, 300, 380, 176)]),
);

/**
 * A slide whose left column holds more than its box, with the right column
 * placed under it: the slide's text steps down until the left column's words
 * stop short of the box below.
 */
export const TextSteppedDownToFit = meta.story({
	render: () => (
		<DrawnSlide slide={RUNS_OUT_OF_ROOM} label="People and bots, its columns one over the other" />
	),
	play: async ({ canvas }) => {
		const figure = canvas.getByRole("figure", {
			name: "People and bots, its columns one over the other",
		});
		const slide = within(figure);
		const lastLine = slide.getByText("Present from any slide");
		const boxBelow = drawnBoxOf(slide.getByRole("heading", { name: "Bots" }));
		await waitFor(() => expect(Number(textStepOf(figure))).toBeLessThan(1));
		await expect(lastLine.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			boxBelow.getBoundingClientRect().top,
		);
	},
});
