import {
	Extension,
	type JSONContent,
	type MarkdownParseHelpers,
	mergeAttributes,
	Node as SchemaNode,
} from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Fragment, type Node, type Schema } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import {
	BOX_COMMENT,
	type BoxRole,
	isSlideLayout,
	layoutComment,
	notesComment,
	type Placement,
	placementFromText,
	placementIn,
	placementText,
	readSlideComments,
	SLIDE_BOX_ROLES,
	SLIDE_SEPARATOR,
	type SlideComment,
	type SlideLayout,
} from "./slides-markdown.ts";
import { withValidContent } from "./valid-content.ts";

/*
 * What a `slides` deck holds as a live document: slides, each laid out by
 * one of a few layouts and filled in. A slide is its body, holding the boxes
 * its layout places (`SLIDE_BOX_ROLES`), each holding the same blocks a
 * document does, and the speaker's notes below it. Its layout is an
 * attribute, and so is where its boxes were placed by hand, if they were; a
 * box somebody removed from the slide stays in its body, marked removed
 * (`isMarkedRemoved`). Neither is in the deck's markdown, so a deck read from
 * markdown has every box on its slide, placed by its layout (see
 * `slides-markdown.ts`). What a body holds is made to fit its layout by
 * `fitSlideBody`, and to a new layout by `laidOutAnew`, never by the schema:
 * while a change of layout waits as a suggestion, the body holds the boxes it
 * holds now and those it would hold, side by side, and the sync layer deletes
 * whatever its schema cannot hold. The nodes here are a deck's alone, so a
 * document can't hold a slide.
 */

export const SLIDE = "slide";
export const SLIDE_BODY = "slideBody";
export const SLIDE_BOX = "slideBox";
export const SPEAKER_NOTES = "speakerNotes";

/** The attribute saying where a slide's boxes were placed by hand: `null` while its layout places them. */
export const PLACEMENT = "placement";

/**
 * What a drawn slide whose boxes were placed by hand says its placement with,
 * as `placementText` writes it: what a slide copied and pasted is read back
 * from, and what the placed slide's styles go by.
 */
export const PLACEMENT_ATTRIBUTE = "data-placement";

/**
 * The attribute of a box marking it removed from its slide: `true` once
 * somebody removed it, and `null` while nobody has, so a box nobody removed
 * holds no such attribute for the sync layer to write.
 */
const REMOVED = "removed";

/** What a box marked removed is drawn with, so a slide copied and pasted keeps the mark. */
const MARKED_REMOVED_ATTRIBUTE = "data-marked-removed";

/** The layout a slide made without one has. */
const DEFAULT_LAYOUT: SlideLayout = "bullets";

/**
 * The sizes a slide's text is drawn at, as parts of its full size, largest
 * first: the first at which it fits the slide is the one it is drawn at, in
 * the app and in a file the deck is saved as.
 */
export const SLIDE_TEXT_STEPS = [1, 0.9, 0.8, 0.7] as const;

/** The slide's layout, or the default when it holds none this version knows. */
export const layoutOf = (slide: Node): SlideLayout => layoutIn(slide.attrs);

const layoutIn = (attributes: Record<string, unknown> | undefined): SlideLayout => {
	const layout = attributes?.layout;
	return isSlideLayout(layout) ? layout : DEFAULT_LAYOUT;
};

/** Where the slide's boxes were placed by hand, or `null` when its layout places them. */
export const placementOf = (slide: Node): Placement | null => placementOfAttributes(slide.attrs);

const placementOfAttributes = (attributes: Record<string, unknown> | undefined) =>
	placementIn(attributes?.[PLACEMENT], layoutIn(attributes));

/** The level of a slide's title: the title slide's is the deck's own, `#`, and every other's `##`. */
const titleLevel = (layout: SlideLayout) => (layout === "title" ? 1 : 2);

/**
 * A new slide of `layout`, as the editor adds one: each box holding the line
 * a box of its role is left with (`emptyLine`), but for an empty bulleted
 * list in a `body` box and an empty table in a `table` box. The editor names
 * its empty boxes with words that are not stored.
 */
export function newSlide(schema: Schema, layout: SlideLayout): Node {
	const node = (name: string, content?: Node | Node[], attributes?: Record<string, unknown>) =>
		nodeType(schema, name).create(attributes ?? null, content);
	const paragraph = () => node("paragraph");
	const row = (cell: "tableHeader" | "tableCell") =>
		node(
			"tableRow",
			Array.from({ length: NEW_TABLE_COLUMNS }, () => node(cell, paragraph())),
		);
	const newContent: Partial<Record<BoxRole, () => Node>> = {
		body: () => node("bulletList", node("listItem", paragraph())),
		table: () => node("table", [row("tableHeader"), row("tableCell"), row("tableCell")]),
	};
	const boxes = SLIDE_BOX_ROLES[layout].map((role) =>
		node(SLIDE_BOX, newContent[role]?.() ?? emptyLine(schema, layout, role)),
	);
	return node(SLIDE, [node(SLIDE_BODY, boxes), node(SPEAKER_NOTES, paragraph())], { layout });
}

/** How many columns a table on a new slide has. */
const NEW_TABLE_COLUMNS = 3;

/** A deck: its slides, and nothing else, with a line of `---` between each two in its markdown. */
export const Deck = Document.extend({
	content: `${SLIDE}+`,
	renderMarkdown: (node, helpers) =>
		helpers.renderChildren(node.content ?? [], `\n\n${SLIDE_SEPARATOR}\n\n`),
});

/**
 * A slide: its layout, where its boxes were placed by hand if they were, its
 * body (`bodyOf`), and the speaker's notes for it (`notesOf`). Drawn, a placed
 * slide says its placement (`PLACEMENT_ATTRIBUTE`); whatever draws its boxes
 * draws each at its frame. Written as markdown, it says its layout and what it
 * holds, never where its boxes were placed or which were removed.
 */
export const Slide = SchemaNode.create({
	name: SLIDE,
	content: `${SLIDE_BODY} ${SPEAKER_NOTES}`,
	isolating: true,
	addAttributes: () => ({
		layout: {
			default: DEFAULT_LAYOUT,
			parseHTML: (element) => element.getAttribute("data-layout"),
			renderHTML: (attributes) => ({ "data-layout": attributes.layout }),
		},
		[PLACEMENT]: {
			default: null,
			parseHTML: (element) =>
				placementFromText(
					element.getAttribute(PLACEMENT_ATTRIBUTE) ?? "",
					layoutIn({ layout: element.getAttribute("data-layout") }),
				),
			renderHTML: (attributes) => {
				const placement = placementOfAttributes(attributes);
				return placement ? { [PLACEMENT_ATTRIBUTE]: placementText(placement) } : {};
			},
		},
	}),
	parseHTML: () => [{ tag: "section[data-slide]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"section",
		mergeAttributes({ "data-slide": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) =>
		nonEmptyParts([
			layoutComment(layoutIn(node.attrs)),
			...(node.content ?? []).map((part) => helpers.renderChildren([part])),
		]),
});

/** `slide`'s body, the first of what it holds, which holds its boxes. */
export const bodyOf = (slide: Node): Node => slide.child(0);

/** `slide`'s speaker's notes, which follow its body. */
export const notesOf = (slide: Node): Node => slide.child(1);

/**
 * Where a slide's first box starts, counted from where the slide starts: past
 * the slide's own start and its body's, as its body is the first of what it
 * holds.
 */
export const FIRST_BOX_IN_SLIDE = 2;

/**
 * A slide's body. It holds boxes, as many and in whatever order the editor
 * and a pending suggestion leave them; `fitSlideBody` makes them the boxes
 * the slide's layout places. Written, each box after the first starts with
 * its comment.
 */
export const SlideBody = SchemaNode.create({
	name: SLIDE_BODY,
	content: `${SLIDE_BOX}+`,
	isolating: true,
	parseHTML: () => [{ tag: "div[data-slide-body]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes({ "data-slide-body": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) =>
		nonEmptyParts(
			(node.content ?? []).map((box, index) =>
				nonEmptyParts([index > 0 ? BOX_COMMENT : "", helpers.renderChildren([box])]),
			),
		),
});

/**
 * One of the boxes a slide's layout places, holding blocks one under another,
 * and whether somebody marked it removed from the slide (`isMarkedRemoved`).
 * Drawn, a box marked removed says so (`data-marked-removed`), which is not
 * whether it is off the slide (`isOffItsSlide`).
 */
export const SlideBox = SchemaNode.create({
	name: SLIDE_BOX,
	content: "block+",
	isolating: true,
	addAttributes: () => ({
		[REMOVED]: {
			default: null,
			parseHTML: (element) => (element.hasAttribute(MARKED_REMOVED_ATTRIBUTE) ? true : null),
			renderHTML: (attributes) =>
				attributes[REMOVED] === true ? { [MARKED_REMOVED_ATTRIBUTE]: "" } : {},
		},
	}),
	parseHTML: () => [{ tag: "div[data-slide-box]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes({ "data-slide-box": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? [], "\n\n"),
});

/**
 * Whether somebody marked `box` removed from its slide. A box so marked is off
 * the slide only while it holds nothing (`isOffItsSlide`).
 */
export const isMarkedRemoved = (box: Node): boolean => box.attrs[REMOVED] === true;

/**
 * Whether `box` is off its slide: marked removed (`isMarkedRemoved`), and
 * holding nothing, as removing it leaves it. A box marked removed that holds
 * something, as one somebody was typing in at the moment it was removed, is
 * on the slide, rather than hiding what they typed. A box off its slide isn't
 * drawn, takes no room on it, and isn't in a file the deck is saved as.
 */
export const isOffItsSlide = (box: Node): boolean => isMarkedRemoved(box) && holdsNothing(box);

/**
 * The boxes `slide`'s body holds, in order, each `undefined` where it is off
 * the slide (`isOffItsSlide`), so each box shown keeps its place among the
 * roles of the slide's layout (`SLIDE_BOX_ROLES`).
 */
export const shownBoxesOf = (slide: Node): (Node | undefined)[] =>
	bodyOf(slide).children.map((box) => (isOffItsSlide(box) ? undefined : box));

/** Whether `holder`, a box or a block, holds no words, images or anything else on a line: nothing but empty lines, as of an empty list or table. */
function holdsNothing(holder: Node): boolean {
	let nothing = true;
	holder.descendants((node) => {
		if (node.isInline) nothing = false;
		return nothing;
	});
	return nothing;
}

/**
 * `change` with the box starting at `boxPos` taken off its slide: what it
 * holds replaced by the line a box of its role is left with (`emptyLine`),
 * and the box marked removed, which together put it off the slide
 * (`isOffItsSlide`). The box stays in its slide's body, so the body still
 * holds a box for each of its layout's roles. Throws a `RangeError` when no
 * box with a role in its slide's layout starts at `boxPos`.
 */
export function takeBoxOffSlide<T extends Transform>(change: T, boxPos: number): T {
	const box = change.doc.nodeAt(boxPos);
	const place = change.doc.resolve(boxPos);
	if (box?.type.name !== SLIDE_BOX || place.depth < 1) {
		throw new RangeError(`No slide's box starts at ${boxPos}`);
	}
	const layout = layoutOf(place.node(place.depth - 1));
	const role = SLIDE_BOX_ROLES[layout][place.index()];
	if (!role) throw new RangeError(`A slide laid out as ${layout} has no box ${place.index()}`);
	return change
		.setNodeAttribute(boxPos, REMOVED, true)
		.replaceWith(
			boxPos + 1,
			boxPos + box.nodeSize - 1,
			emptyLine(change.doc.type.schema, layout, role),
		);
}

/**
 * `change` with the boxes of the slide starting at `slidePos` left to its
 * layout: no longer placed by hand, and every box marked removed back on the
 * slide, holding what it holds. Only the attributes saying either change, so
 * whatever anybody is typing in the slide is kept. Throws a `RangeError` when
 * no slide starts at `slidePos`.
 */
export function leaveBoxesToLayout<T extends Transform>(change: T, slidePos: number): T {
	const slide = change.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) throw new RangeError(`No slide starts at ${slidePos}`);
	if (slide.attrs[PLACEMENT] !== null) change.setNodeAttribute(slidePos, PLACEMENT, null);
	const boxesStart = slidePos + FIRST_BOX_IN_SLIDE;
	bodyOf(slide).forEach((box, offset) => {
		if (isMarkedRemoved(box)) change.setNodeAttribute(boxesStart + offset, REMOVED, null);
	});
	return change;
}

/**
 * What the speaker says over a slide: plain paragraphs, which several people
 * can type in at once as they can in a document. Written only when it says
 * something.
 */
export const SpeakerNotes = SchemaNode.create({
	name: SPEAKER_NOTES,
	content: "paragraph+",
	isolating: true,
	parseHTML: () => [{ tag: "aside[data-speaker-notes]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"aside",
		mergeAttributes({ "data-speaker-notes": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) => {
		const paragraphs = node.content ?? [];
		if (paragraphs.every(isEmptyParagraph)) return "";
		return notesComment(
			paragraphs
				.map((paragraph) =>
					isEmptyParagraph(paragraph) ? EMPTY_PARAGRAPH : helpers.renderChildren([paragraph]),
				)
				.join("\n\n"),
		);
	},
});

/** What an empty paragraph is written as, as the paragraph's own markdown writes one. */
const EMPTY_PARAGRAPH = "&nbsp;";

const nonEmptyParts = (parts: string[]) => parts.filter((part) => part !== "").join("\n\n");

/*
 * Reading a deck's markdown. The markdown reader turns its comments and its
 * lines of `---` into stand-ins among the blocks it reads, which
 * `deckFromParsedMarkdown` then makes the slides from.
 */

/** Stands in for a deck's comments, or a line between two slides, among the blocks read. */
const SLIDE_MARKUP = "slideMarkup";

/**
 * What a stand-in says, in the order the markdown says it: a line between two
 * slides, or one of the deck's comments, a slide's notes read as paragraphs.
 */
type Said =
	| { kind: "break" }
	| Exclude<SlideComment, { kind: "notes" }>
	| { kind: "notes"; paragraphs: JSONContent[] };

interface SlideMarkup extends JSONContent {
	type: typeof SLIDE_MARKUP;
	attrs: { said: Said[]; raw: string };
}

const slideMarkup = (said: Said[], raw: string): SlideMarkup => ({
	type: SLIDE_MARKUP,
	attrs: { said, raw },
});

const isSlideMarkup = (node: JSONContent): node is SlideMarkup => node.type === SLIDE_MARKUP;

/** Reads a deck's comments; other HTML is read as a document reads it, as its text. */
const SlideComments = Extension.create({
	name: "slideComments",
	markdownTokenName: "html",
	parseMarkdown: (token, helpers) => {
		const raw = token.raw ?? token.text ?? "";
		const read = readSlideComments(raw);
		if (!read) return [];
		const said = read.comments.map(
			(comment): Said =>
				comment.kind === "notes"
					? { kind: "notes", paragraphs: notesParagraphs(comment.markdown, helpers) }
					: comment,
		);
		const after =
			read.rest === "" ? [] : [{ type: "paragraph", content: inline(read.rest, helpers) }];
		return [slideMarkup(said, raw.trim()), ...after];
	},
});

/** Reads a line of `---`, or any other thematic break, as the line between two slides. */
const SlideBreaks = Extension.create({
	name: "slideBreaks",
	markdownTokenName: "hr",
	parseMarkdown: (token) => slideMarkup([{ kind: "break" }], token.raw ?? ""),
});

/** What reads a deck's comments and slide breaks from its markdown, for a deck's extensions. */
export const slideMarkdownReaders = [SlideComments, SlideBreaks];

/** The paragraphs of notes written as markdown, read as plain lines of text, not as blocks. */
function notesParagraphs(markdown: string, helpers: MarkdownParseHelpers): JSONContent[] {
	return markdown
		.split(/\n[ \t]*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== "")
		.map((paragraph) =>
			paragraph === EMPTY_PARAGRAPH
				? { type: "paragraph" }
				: { type: "paragraph", content: inline(paragraph, helpers) },
		);
}

const inline = (markdown: string, helpers: MarkdownParseHelpers): JSONContent[] =>
	helpers.tokenizeInline
		? helpers.parseInline(helpers.tokenizeInline(markdown))
		: [helpers.createTextNode(markdown)];

/** A slide as its markdown says it, before it is made to fit its layout. */
interface SlideDraft {
	/** The layout its comment names, as written. */
	layout?: string;
	/** The blocks before its first box comment, or all of them without box comments. */
	flow: JSONContent[];
	/** The blocks after each of its box comments. */
	boxes: JSONContent[][];
	notes: JSONContent[];
}

const newDraft = (): SlideDraft => ({ flow: [], boxes: [], notes: [] });

/**
 * The deck `parsed`, what the markdown reader made of a deck's markdown,
 * says. Forgiving, as bots write it by hand: a slide whose layout is missing,
 * or one this version doesn't know, is given the layout its content suggests
 * (`guessedLayout`), and every slide is made to fit its layout, once what it
 * holds that the schema has no place for is made to fit that (see
 * `withValidContent`). A layout comment in a slide that already has one
 * starts the next slide, as when the line between them was left out. A line
 * of `---` with nothing but blank lines before the next makes no slide, but a
 * slide holding only its layout comment is kept, as an empty slide. Markdown
 * that says nothing is one empty title slide.
 */
export function deckFromParsedMarkdown(parsed: JSONContent, schema: Schema): Node {
	const drafts = draftsOf(parsed.content ?? []).filter(saysSomething);
	const slides = (drafts.length > 0 ? drafts : [{ ...newDraft(), layout: "title" }]).map(
		(draft, index) => slideOf(draft, index, schema),
	);
	return schema.topNodeType.create(null, slides);
}

function draftsOf(content: readonly JSONContent[]): SlideDraft[] {
	const drafts = [newDraft()];
	let draft = drafts[0] as SlideDraft;
	const startSlide = () => {
		draft = newDraft();
		drafts.push(draft);
	};
	for (const node of content) {
		if (!isSlideMarkup(node)) {
			(draft.boxes.at(-1) ?? draft.flow).push(withMarkupAsText(node));
			continue;
		}
		for (const said of node.attrs.said) {
			switch (said.kind) {
				case "break":
					startSlide();
					break;
				case "layout":
					if (draft.layout !== undefined) startSlide();
					draft.layout = said.layout;
					break;
				case "box":
					draft.boxes.push([]);
					break;
				case "notes":
					for (const paragraph of said.paragraphs) draft.notes.push(paragraph);
					break;
			}
		}
	}
	return drafts;
}

/** Whether a slide as written says anything: a layout, a box, notes or a block with something in it. */
const saysSomething = (draft: SlideDraft) =>
	draft.layout !== undefined ||
	draft.boxes.length > 0 ||
	draft.notes.length > 0 ||
	draft.flow.some((block) => !isEmptyParagraph(block));

/**
 * `node` with the deck's markup inside it, as in a quote, read as a document
 * reads it: a comment as its text, and a line of `---` as nothing, as a slide
 * holds no such line.
 */
function withMarkupAsText(node: JSONContent): JSONContent {
	if (!node.content) return node;
	return {
		...node,
		content: node.content.flatMap((child) => {
			if (!isSlideMarkup(child)) return [withMarkupAsText(child)];
			const breakOnly = child.attrs.said.every((said) => said.kind === "break");
			return breakOnly
				? []
				: [{ type: "paragraph", content: [{ type: "text", text: child.attrs.raw }] }];
		}),
	};
}

/**
 * The slide `draft` says. Its blocks are fitted to its layout before they
 * are made valid, as a body holds only boxes, and blocks standing in no box
 * are shared out among them by the layout (see `fitSlideBody`) rather than
 * each put in a box of its own.
 */
function slideOf(draft: SlideDraft, index: number, schema: Schema): Node {
	const layout = isSlideLayout(draft.layout) ? draft.layout : guessedLayout(draft, index);
	const blocks =
		draft.boxes.length === 0
			? draft.flow
			: [draft.flow, ...draft.boxes].map((content) => ({ type: SLIDE_BOX, content }));
	const body = fitSlideBody(
		nodeType(schema, SLIDE_BODY).create(null, Fragment.fromJSON(schema, blocks)),
		layout,
	);
	const notes = withValidContent(
		nodeType(schema, SPEAKER_NOTES).create(null, Fragment.fromJSON(schema, draft.notes)),
	);
	return nodeType(schema, SLIDE).create({ layout }, [withValidContent(body), notes]);
}

/** The most characters the paragraph under a title may have for the slide to be taken for a title slide. */
const SUBTITLE_MAX_CHARACTERS = 100;

/**
 * The layout a slide's content suggests, for a slide that names none it
 * knows: `columns` for one in three boxes or more, `table` for one holding a
 * table, `quote` for a quote alone or with a line saying whose it is, a title
 * slide (`title` first, `section` after) for a heading alone or over a short
 * paragraph, and `bullets` for anything else.
 */
function guessedLayout({ flow, boxes }: SlideDraft, index: number): SlideLayout {
	if (boxes.length > 1) return "columns";
	const blocks = [...flow, ...boxes.flat()].filter((block) => !isEmptyParagraph(block));
	if (blocks.some((block) => block.type === "table")) return "table";
	const [first, second, ...more] = blocks;
	const alone = second === undefined;
	const thenShortParagraph =
		second?.type === "paragraph" &&
		more.length === 0 &&
		textOf(second).length <= SUBTITLE_MAX_CHARACTERS;
	if (
		first?.type === "blockquote" &&
		(alone || (second?.type === "paragraph" && more.length === 0))
	) {
		return "quote";
	}
	if (first === undefined || (first.type === "heading" && (alone || thenShortParagraph))) {
		return index === 0 ? "title" : "section";
	}
	return "bullets";
}

const textOf = (node: JSONContent): string =>
	node.text ?? (node.content ?? []).map(textOf).join("");

const isEmptyParagraph = (node: JSONContent) =>
	node.type === "paragraph" && (node.content ?? []).length === 0;

/**
 * `body`, a slide's body, holding exactly the boxes `layout` places, in
 * order, having lost nothing: `body` itself when it does already. What each
 * box is to hold comes from `body` (`heldBlocks`): its boxes, box for box, or
 * blocks standing in no box, as markdown that says no boxes is read, shared
 * out by the layout. A box the layout places that `body` lacks is added, and
 * a box left with nothing is given its line to type in (`emptyLine`). A box
 * marked removed that holds something, as when somebody typed in it as it was
 * removed, is no longer marked (see `isOffItsSlide`), so it isn't taken off
 * the slide again when what it holds is next deleted.
 *
 * Box for box is how a body fits the layout its boxes are in order for: a
 * slide given a new layout is laid out by `laidOutAnew`, which moves what its
 * boxes hold by what each is for. A body holding a suggestion to change its
 * slide's layout holds both layouts' boxes until the suggestion is settled,
 * and is to be fitted only once it is.
 */
export function fitSlideBody(body: Node, layout: SlideLayout): Node {
	const schema = body.type.schema;
	const held = heldBlocks(body.content.content, layout);
	const boxes = SLIDE_BOX_ROLES[layout].map((role, index) => {
		const { box, blocks } = held[index] ?? { box: undefined, blocks: [] };
		const content = Fragment.fromArray(
			blocks.length > 0 ? [...blocks] : [emptyLine(schema, layout, role)],
		);
		return box
			? onSlideOnceFilled(box.copy(content))
			: nodeType(schema, SLIDE_BOX).create(null, content);
	});
	const fitted = Fragment.fromArray(boxes);
	return fitted.eq(body.content) ? body : body.copy(fitted);
}

/** `box`, no longer marked removed when it is marked and holds something. */
const onSlideOnceFilled = (box: Node): Node =>
	isMarkedRemoved(box) && !isOffItsSlide(box) ? unmarked(box) : box;

/** `box`, no longer marked removed, holding what it holds. */
const unmarked = (box: Node): Node =>
	box.type.create({ ...box.attrs, [REMOVED]: null }, box.content, box.marks);

/**
 * `slide` laid out anew by `layout`, as a change of a slide's layout lays it
 * out, whoever makes it: no longer placed by hand, as a placement is of the
 * old layout's boxes; with every box marked removed back on it, holding what
 * it holds; and with what its boxes hold moved to the new layout's by what
 * each box is for (`boxesInNewLayout`). Given the layout it has, its boxes
 * keep what they hold, box for box.
 */
export function laidOutAnew(slide: Node, layout: SlideLayout): Node {
	const body = bodyOf(slide);
	const everyBoxOnSlide = body.copy(
		Fragment.fromArray(body.children.map((box) => (isMarkedRemoved(box) ? unmarked(box) : box))),
	);
	return slide.type.create(
		{ ...slide.attrs, layout, [PLACEMENT]: null },
		slide.content.replaceChild(0, boxesInNewLayout(everyBoxOnSlide, layoutOf(slide), layout)),
		slide.marks,
	);
}

/** A box of a body being laid out anew, if it is one already, and the blocks it holds or is to hold. */
interface Moving {
	box: Node | undefined;
	blocks: readonly Node[];
}

/**
 * `body`, the body of a slide laid out by `from`, holding the boxes `to`
 * places instead, having lost nothing. A box of a role both layouts have, as
 * the slide's title, keeps what it holds. The other boxes go, in order, to
 * the boxes of `to` left, one to each, those past the last joining it. A
 * section break has a box left only for its label, which is never given
 * another box's blocks: they go under its title, in its title's box. So a
 * section break's title box holds its title and what is under it, which
 * another layout has a box of its own for: leaving the section break, its
 * title keeps only the heading the box starts with, and what follows goes on
 * as another box would, after the label. A box holding nothing gives nothing
 * but keeps its place, so a right column stays the right one; but a label
 * holding nothing has no place to keep, as no other layout has one. A box
 * left with nothing is given its line to type in (`emptyLine`).
 */
function boxesInNewLayout(body: Node, from: SlideLayout, to: SlideLayout): Node {
	if (from === to) return fitSlideBody(body, to);
	const schema = body.type.schema;
	const was: readonly BoxRole[] = SLIDE_BOX_ROLES[from];
	const becomes: readonly BoxRole[] = SLIDE_BOX_ROLES[to];
	const kept = new Map<BoxRole, Moving>();
	const others: Moving[] = [];
	fitSlideBody(body, from).forEach((box, _offset, index) => {
		const role = was[index];
		const blocks = box.content.content;
		if (role === "title" && from === "section" && becomes.includes(role)) {
			const title = blocks[0]?.type.name === "heading" ? blocks.slice(0, 1) : [];
			kept.set(role, { box, blocks: title });
			if (blocks.length > title.length) {
				others.push({ box: undefined, blocks: blocks.slice(title.length) });
			}
			return;
		}
		if (role && becomes.includes(role)) {
			kept.set(role, { box, blocks });
			return;
		}
		if (role === "label" && holdsNothing(box)) return;
		others.push({ box, blocks });
	});
	const left = becomes.filter((role) => !kept.has(role) && role !== "label");
	const joining = new Map<BoxRole, Moving>();
	others.forEach((other, index) => {
		const role = left[Math.min(index, left.length - 1)] ?? becomes.at(-1);
		if (!role) return;
		const already = joining.get(role);
		const given = other.blocks.every(holdsNothing) ? [] : other.blocks;
		joining.set(role, {
			box: already?.box ?? other.box,
			blocks: [...(already?.blocks ?? []), ...given],
		});
	});
	const boxes = becomes.map((role) => {
		const keeps = kept.get(role);
		const joins = joining.get(role);
		const blocks = [...(keeps?.blocks ?? []), ...(joins?.blocks ?? [])];
		const content = Fragment.fromArray(blocks.length > 0 ? blocks : [emptyLine(schema, to, role)]);
		const box = keeps?.box ?? joins?.box;
		if (!box) return nodeType(schema, SLIDE_BOX).create(null, content);
		return box.content.eq(content) ? box : box.copy(content);
	});
	return body.copy(Fragment.fromArray(boxes));
}

/** A box of a body being fitted, if it was one already, and the blocks it is to hold. */
interface Held {
	box: Node | undefined;
	blocks: readonly Node[];
}

/**
 * What each box `layout` places is to hold, in order, from `children`, what
 * a slide's body holds: either blocks standing in no box, as markdown that
 * says no boxes is read, shared out by the layout (`sharedOut`), or boxes.
 * Boxes keep what they hold, box for box, and those past the layout's last
 * join it, after what it holds; a box among those holding only an empty
 * paragraph, the line it was given to type in, gives nothing.
 */
function heldBlocks(children: readonly Node[], layout: SlideLayout): Held[] {
	const boxes = children.filter((child) => child.type.name === SLIDE_BOX);
	if (boxes.length === 0) {
		return sharedOut(children, layout).map((blocks) => ({ box: undefined, blocks }));
	}
	const held = boxes.map((box) => ({ box, blocks: box.content.content }));
	const count = SLIDE_BOX_ROLES[layout].length;
	if (held.length <= count) return held;
	const joined = held.slice(count - 1);
	return [
		...held.slice(0, count - 1),
		{
			box: joined[0]?.box,
			blocks: joined.flatMap(({ blocks }) => (isOnlyAnEmptyParagraph(blocks) ? [] : blocks)),
		},
	];
}

/**
 * `blocks`, standing in no box, shared out between the first two boxes of a
 * slide of `layout`: the first takes the blocks the slide starts with that
 * belong in it (`leadingCount`), and the second the rest. A third box, as a
 * right column, is given none.
 */
function sharedOut(blocks: readonly Node[], layout: SlideLayout): Node[][] {
	const leading = leadingCount(blocks, layout);
	return [blocks.slice(0, leading), blocks.slice(leading)];
}

/**
 * How many of `blocks` the first box of a slide of `layout` takes. A section
 * break's first box is its label, which takes the blocks before the first
 * heading, or all of them without one. A quote slide's is its quote, which
 * takes a quote the blocks start with. Every other layout's is its title,
 * which takes a heading the blocks start with.
 */
function leadingCount(blocks: readonly Node[], layout: SlideLayout): number {
	if (layout === "section") {
		const title = blocks.findIndex((block) => block.type.name === "heading");
		return title < 0 ? blocks.length : title;
	}
	const leader = layout === "quote" ? "blockquote" : "heading";
	return blocks[0]?.type.name === leader ? 1 : 0;
}

/**
 * The line a box of `role` on a slide of `layout` is given when it is left
 * with nothing, or taken off its slide: an empty heading at the slide's title
 * level for its title, an empty quote for its quote, and an empty paragraph
 * for any other, so what is typed there is styled as the box styles it.
 */
function emptyLine(schema: Schema, layout: SlideLayout, role: BoxRole): Node {
	if (role === "title") return emptyTitle(schema, layout);
	if (role === "quote") return emptyQuote(schema);
	return nodeType(schema, "paragraph").create();
}

const emptyTitle = (schema: Schema, layout: SlideLayout) =>
	nodeType(schema, "heading").create({ level: titleLevel(layout) });

const emptyQuote = (schema: Schema) =>
	nodeType(schema, "blockquote").create(null, nodeType(schema, "paragraph").create());

const isOnlyAnEmptyParagraph = (blocks: readonly Node[]) =>
	blocks.length === 1 && blocks[0]?.type.name === "paragraph" && blocks[0].childCount === 0;

function nodeType(schema: Schema, name: string) {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type;
}
