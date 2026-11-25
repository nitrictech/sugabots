import {
	Extension,
	type JSONContent,
	type MarkdownParseHelpers,
	mergeAttributes,
	Node as SchemaNode,
} from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Fragment, type Node, type Schema } from "@tiptap/pm/model";
import {
	COLUMN_COMMENT,
	isSlideLayout,
	layoutComment,
	layoutHasColumns,
	notesComment,
	readSlideComments,
	SLIDE_SEPARATOR,
	type SlideLayout,
} from "./slides-markdown.ts";
import { withValidContent } from "./valid-content.ts";

/*
 * What a `slides` deck holds as a live document: slides, each laid out by
 * one of a few layouts and filled in, with nothing placed freely. A slide is
 * its frame, holding the same blocks a document does, and the speaker's notes
 * below it. Its layout is an attribute, and what its frame holds is made to
 * fit the layout by `fitSlideBody`, never by the schema: while a change of
 * layout waits as a suggestion, the frame holds what it holds now and what it
 * would hold, side by side, and the sync layer deletes whatever its schema
 * cannot hold. The nodes here are a deck's alone, so a document can't hold
 * a slide.
 */

export const SLIDE = "slide";
export const SLIDE_BODY = "slideBody";
export const SLIDE_COLUMN = "slideColumn";
export const SPEAKER_NOTES = "speakerNotes";

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

/**
 * A new slide of `layout`, as the editor adds one: its regions empty, which
 * the editor names with words that are not stored.
 */
export function newSlide(schema: Schema, layout: SlideLayout): Node {
	const node = (name: string, content?: Node | Node[], attributes?: Record<string, unknown>) =>
		nodeType(schema, name).create(attributes ?? null, content);
	const paragraph = () => node("paragraph");
	const heading = (level: number) => node("heading", undefined, { level });
	const column = () => node(SLIDE_COLUMN, paragraph());
	const row = (cell: "tableHeader" | "tableCell") =>
		node(
			"tableRow",
			Array.from({ length: NEW_TABLE_COLUMNS }, () => node(cell, paragraph())),
		);
	const regions: Record<SlideLayout, () => Node[]> = {
		title: () => [heading(1), paragraph()],
		bullets: () => [heading(2), node("bulletList", node("listItem", paragraph()))],
		columns: () => [heading(2), column(), column()],
		image: () => [heading(2), column(), column()],
		// Its label, such as "Part 2", sits over its title.
		section: () => [paragraph(), heading(2)],
		quote: () => [node("blockquote", paragraph()), paragraph()],
		table: () => [
			heading(2),
			node("table", [row("tableHeader"), row("tableCell"), row("tableCell")]),
		],
	};
	return node(SLIDE, [node(SLIDE_BODY, regions[layout]()), node(SPEAKER_NOTES, paragraph())], {
		layout,
	});
}

/** How many columns a table on a new slide has. */
const NEW_TABLE_COLUMNS = 3;

/** A deck: its slides, and nothing else, with a line of `---` between each two in its markdown. */
export const Deck = Document.extend({
	content: `${SLIDE}+`,
	renderMarkdown: (node, helpers) =>
		helpers.renderChildren(node.content ?? [], `\n\n${SLIDE_SEPARATOR}\n\n`),
});

/** A slide: its layout, its frame, and the speaker's notes for it. */
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

/**
 * A slide's frame. It holds blocks and columns in any order, as the editor
 * and a pending suggestion may leave them; `fitSlideBody` puts them in the
 * order the slide's layout says.
 */
export const SlideBody = SchemaNode.create({
	name: SLIDE_BODY,
	content: `(block | ${SLIDE_COLUMN})+`,
	isolating: true,
	parseHTML: () => [{ tag: "div[data-slide-body]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes({ "data-slide-body": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? [], "\n\n"),
});

/** One of the two columns of a slide laid out in columns. */
export const SlideColumn = SchemaNode.create({
	name: SLIDE_COLUMN,
	content: "block+",
	isolating: true,
	parseHTML: () => [{ tag: "div[data-slide-column]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes({ "data-slide-column": "" }, HTMLAttributes),
		0,
	],
	renderMarkdown: (node, helpers) =>
		nonEmptyParts([COLUMN_COMMENT, helpers.renderChildren(node.content ?? [], "\n\n")]),
});

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

/** What a stand-in says, in the order the markdown says it. */
type Said =
	| { kind: "break" }
	| { kind: "layout"; layout: string }
	| { kind: "column" }
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
	/** The blocks before its first column, or all of them without columns. */
	flow: JSONContent[];
	columns: JSONContent[][];
	notes: JSONContent[];
}

const newDraft = (): SlideDraft => ({ flow: [], columns: [], notes: [] });

/**
 * The deck `parsed`, what the markdown reader made of a deck's markdown,
 * says. Forgiving, as bots write it by hand: a slide whose layout is missing,
 * or one this version doesn't know, is given the layout its content suggests
 * (`guessedLayout`), and every slide is made to fit its layout, once what it
 * holds that the schema has no place for is made to fit that (see
 * `withValidContent`). A layout
 * comment in a slide that already has one starts the next slide, as when the
 * line between them was left out. A line of `---` with nothing but blank
 * lines before the next makes no slide, but a slide holding only its layout
 * comment is kept, as an empty slide. Markdown that says nothing is one empty
 * title slide.
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
			(draft.columns.at(-1) ?? draft.flow).push(withMarkupAsText(node));
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
				case "column":
					draft.columns.push([]);
					break;
				case "notes":
					for (const paragraph of said.paragraphs) draft.notes.push(paragraph);
					break;
			}
		}
	}
	return drafts;
}

/** Whether a slide as written says anything: a layout, a column, notes or a block with something in it. */
const saysSomething = (draft: SlideDraft) =>
	draft.layout !== undefined ||
	draft.columns.length > 0 ||
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

function slideOf(draft: SlideDraft, index: number, schema: Schema): Node {
	const layout = isSlideLayout(draft.layout) ? draft.layout : guessedLayout(draft, index);
	const blocks = [
		...draft.flow,
		...draft.columns.map((column) => ({ type: SLIDE_COLUMN, content: column })),
	];
	const body = withValidContent(
		nodeType(schema, SLIDE_BODY).create(null, Fragment.fromJSON(schema, blocks)),
	);
	const notes = withValidContent(
		nodeType(schema, SPEAKER_NOTES).create(null, Fragment.fromJSON(schema, draft.notes)),
	);
	return nodeType(schema, SLIDE).create({ layout }, [fitSlideBody(body, layout), notes]);
}

/** The most characters the paragraph under a title may have for the slide to be taken for a title slide. */
const SUBTITLE_MAX_CHARACTERS = 100;

/**
 * The layout a slide's content suggests, for a slide that names none it
 * knows: `columns` for one with columns, `table` for one holding a table,
 * `quote` for a quote alone or with a line saying whose it is, a title slide
 * (`title` first, `section` after) for a heading alone or over a short
 * paragraph, and `bullets` for anything else.
 */
function guessedLayout({ flow, columns }: SlideDraft, index: number): SlideLayout {
	if (columns.length > 0) return "columns";
	const blocks = flow.filter((block) => !isEmptyParagraph(block));
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
 * `body`, a slide's frame, holding what it holds in the order `layout` says,
 * having lost nothing: `body` itself when it does already. With columns, an
 * optional heading, the slide's title, then exactly two columns: what stood
 * before the first column goes at its start, what stood after a column goes
 * at its end, and a third column or more goes into the second. Without, one
 * flow of blocks, each column's where the column was. A column holding only
 * the empty paragraph it was given to type in holds nothing to keep, and a
 * column, or a frame without columns, left empty is given one.
 *
 * It fits content as it reads. A frame holding a suggestion to change its
 * slide's layout holds both layouts' content until the suggestion is
 * settled, so it is fitted once it is.
 */
export function fitSlideBody(body: Node, layout: SlideLayout): Node {
	const children = body.content.content;
	const schema = body.type.schema;
	const fitted = Fragment.fromArray(
		layoutHasColumns(layout) ? inTwoColumns(children, schema) : inOneFlow(children, schema),
	);
	return fitted.eq(body.content) ? body : body.copy(fitted);
}

function inOneFlow(children: readonly Node[], schema: Schema): Node[] {
	const blocks = children.flatMap((child) => {
		if (child.type.name !== SLIDE_COLUMN) return [child];
		return holdsOnlyAnEmptyParagraph(child) ? [] : child.content.content;
	});
	return blocks.length > 0 ? blocks : [emptyParagraph(schema)];
}

function inTwoColumns(children: readonly Node[], schema: Schema): Node[] {
	const [first] = children;
	const title = first?.type.name === "heading" ? [first] : [];
	const beforeColumns: Node[] = [];
	const columns: { column: Node; blocks: Node[] }[] = [];
	for (const child of children.slice(title.length)) {
		if (child.type.name !== SLIDE_COLUMN) {
			(columns.at(-1)?.blocks ?? beforeColumns).push(child);
			continue;
		}
		const blocks = holdsOnlyAnEmptyParagraph(child) ? [] : [...child.content.content];
		columns.push({ column: child, blocks });
	}
	const [left, right, ...more] = columns;
	return [
		...title,
		column(left?.column, [...beforeColumns, ...(left?.blocks ?? [])], schema),
		column(
			right?.column,
			[...(right?.blocks ?? []), ...more.flatMap(({ blocks }) => blocks)],
			schema,
		),
	];
}

/** `existing`, or a new column, holding `blocks`, or an empty paragraph when there are none. */
function column(existing: Node | undefined, blocks: readonly Node[], schema: Schema): Node {
	const content = Fragment.fromArray(blocks.length > 0 ? [...blocks] : [emptyParagraph(schema)]);
	return existing ? existing.copy(content) : nodeType(schema, SLIDE_COLUMN).create(null, content);
}

const holdsOnlyAnEmptyParagraph = (region: Node) =>
	region.childCount === 1 &&
	region.firstChild?.type.name === "paragraph" &&
	region.firstChild.childCount === 0;

const emptyParagraph = (schema: Schema) => nodeType(schema, "paragraph").create();

function nodeType(schema: Schema, name: string) {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type;
}
