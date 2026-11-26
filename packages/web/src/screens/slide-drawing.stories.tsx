import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { liveDocumentFromMarkdown } from "@sugabots/contracts/live-document-markdown";
import { layoutOf, PLACEMENT, takeBoxOffSlide } from "@sugabots/contracts/live-slides";
import { type Frame, placementIn } from "@sugabots/contracts/slides-markdown";
import { getSchema } from "@tiptap/core";
import { DOMSerializer, type Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { boxesOf, LAYOUT_NAMES } from "@/lib/deck.ts";
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

const TITLE = "<!-- layout: title -->\n\n# Q4 outreach plan\n\nGrowth Desk, October 2026";

const GOALS = `<!-- layout: bullets -->

## Goals

- Book 40 discovery calls with mid-market accounts
- Reactivate the 12 stalled Proposal-stage deals
- Publish the new pricing page before December`;

const PEOPLE_AND_BOTS = `<!-- layout: columns -->

## People and bots

<!-- box -->

### People

- Type in the deck together
- Accept or undo suggestions
- Present from any slide

<!-- box -->

### Bots

- Suggest edits when asked
- Draft new slides
- Read the speaker's notes`;

const PIPELINE = `<!-- layout: image -->

## Pipeline by stage

<!-- box -->

Leads doubled since July, and twice as many reach a proposal.

<!-- box -->

![Deals at each stage, from lead to won](${artifactImageAddress(chartIds)})`;

const PART_TWO = "<!-- layout: section -->\n\nPart 2\n\n## What we build next";

const QUOTE = `<!-- layout: quote -->

> Ship the small thing first, then listen.

The growth team's rule for Q4`;

const RISKS = `<!-- layout: table -->

## Risks

| Risk | Owner |
| --- | --- |
| Holiday slowdown in December | Growth Desk |
| Pricing page still in review | Kim |`;

/** The one slide `markdown` says, as a deck read from markdown holds it: every box placed by its layout. */
const slideOf = (markdown: string): Node => liveDocumentFromMarkdown("slides", markdown).child(0);

/** The one slide `markdown` says, with its boxes placed by hand at `frames`, a frame for each box in order. */
function slidePlacedAt(markdown: string, frames: Frame[]): Node {
	const slide = slideOf(markdown);
	const placement = placementIn(frames, layoutOf(slide));
	if (!placement) throw new RangeError("The frames are no placement for the slide's layout");
	return slide.type.create({ ...slide.attrs, [PLACEMENT]: placement }, slide.content, slide.marks);
}

/** The one slide `markdown` says, with the box at `box` deleted from it, as Delete on the box's outline deletes it. */
function slideWithoutBox(markdown: string, box: number): Node {
	const deck = liveDocumentFromMarkdown("slides", markdown);
	const deleted = boxesOf(deck.child(0))[box];
	if (!deleted) throw new RangeError(`The slide has no box ${box}`);
	// The deck holds only this slide, which starts where the deck does.
	return takeBoxOffSlide(new Transform(deck), deleted.startInSlide).doc.child(0);
}

/**
 * The step at which the slide drawn in `figure` draws its text, as a part of
 * its full size: "1" at full size, less once stepped down (see `fitSlideText`).
 */
const textStepOf = (figure: HTMLElement) =>
	figure.querySelector<HTMLElement>("[data-slide]")?.style.getPropertyValue("--slide-fit");

/** The drawn box of a slide that `element` is in. */
function drawnBoxOf(element: HTMLElement): HTMLElement {
	const box = element.closest<HTMLElement>(DRAWN_BOX);
	if (!box) throw new Error("The element is in no box of the slide");
	return box;
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

const EVERY_LAYOUT = [TITLE, GOALS, PEOPLE_AND_BOTS, PIPELINE, PART_TWO, QUOTE, RISKS].map(slideOf);

/**
 * A slide of each layout, its boxes where the layout places them, as a deck
 * read from markdown, a bot's included, is drawn in the strip of slides, in
 * present mode and wherever the deck is only read.
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

const GOALS_PLACED = slidePlacedAt(GOALS, [
	{ x: 80, y: 64, width: 280, height: 160 },
	{ x: 400, y: 64, width: 480, height: 412 },
]);

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

/** Sized off its width, a slide placed by hand keeps where its boxes are at a phone's width. */
export const PlacedByHandOnAPhone = meta.story({
	...PlacedByHand.input,
	globals: { viewport: { value: "mobile1" }, theme: "light" },
});

/**
 * A two-column slide with its left column deleted. The right column stays on
 * the right, where a file the deck is saved as puts it too.
 */
export const ColumnDeleted = meta.story({
	render: () => (
		<DrawnSlide
			slide={slideWithoutBox(PEOPLE_AND_BOTS, 1)}
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
		<DrawnSlide slide={slideWithoutBox(PART_TWO, 0)} label="Part 2, its label deleted" />
	),
	play: async ({ canvas }) => {
		const figure = canvas.getByRole("figure", { name: "Part 2, its label deleted" });
		const slide = within(figure);
		await expect(slide.queryByText("Part 2")).toBeNull();
		await expect(slide.getByRole("heading", { name: "What we build next" })).toBeVisible();
		const label = figure.querySelector<HTMLElement>('[data-box-role="label"]');
		await expect(label).not.toBeVisible();
	},
});

const RUNS_PAST_ITS_BOX = slidePlacedAt(PEOPLE_AND_BOTS, [
	{ x: 80, y: 64, width: 800, height: 64 },
	{ x: 80, y: 160, width: 380, height: 80 },
	{ x: 500, y: 160, width: 380, height: 316 },
]);

/**
 * A placed slide whose left column holds more than its box: what runs past
 * the foot of the box is drawn under it, at full size, as nothing on the
 * slide is in its way.
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

const RUNS_OUT_OF_ROOM = slidePlacedAt(PEOPLE_AND_BOTS, [
	{ x: 80, y: 64, width: 800, height: 64 },
	{ x: 80, y: 160, width: 380, height: 80 },
	{ x: 80, y: 300, width: 380, height: 176 },
]);

/**
 * A placed slide whose left column holds more than its box, with the right
 * column placed under it: the slide's text steps down until the left
 * column's words stop short of the box below.
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
