import { getSchema } from "@tiptap/core";
import {
	type DOMOutputSpec,
	DOMSerializer,
	type Node,
	type ParseRule,
	DOMParser as ProseMirrorParser,
	type Schema,
	type TagParseRule,
} from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { type StyledElement, styleProperty } from "./css-values.ts";
import {
	liveDocumentExtensions,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	SUGGESTED_MODIFICATION,
} from "./live-document.ts";
import { BOX_CONTENT_ATTRIBUTE, newSlide, SLIDE } from "./live-slides.ts";

/*
 * A deck as HTML, the form it is kept in outside the editor: every version
 * of a deck is its HTML, and bots read and write it. It is what the deck's
 * schema draws (see `live-slides.ts`), slide after slide, each a section, so
 * one definition says both how the editor draws a deck and how it is written
 * down. Written, it leaves out two things the schema draws that say nothing,
 * and reads back the same without them: a slide's notes when they are one
 * empty line, and the element a box holds its blocks in. And a paragraph or
 * heading whose spaces HTML would close up, as two in a row or one at its
 * end, says `white-space: pre-wrap`, by which they are read back as they are.
 * Each slide, its body and each of its boxes start on lines of their own:
 *
 *     <section data-slide data-layout="title">
 *       <div data-slide-body>
 *         <div data-slide-box data-role="title" data-vertical-align="bottom" style="left: 80px; top: 100px; width: 800px; height: 176px">
 *           <h1>Quarterly review</h1>
 *         </div>
 *       </div>
 *       <aside data-speaker-notes><p>Welcome everyone.</p></aside>
 *     </section>
 *
 * Read, it is forgiving, as bots write it by hand (see `readDeckHtml`), but
 * never at the cost of what it says: HTML that can't be read whole is told
 * apart from a deck, and so is HTML that says nothing.
 */

/** A deck's schema outside the editor. */
export const DECK_SCHEMA: Schema = getSchema(
	liveDocumentExtensions({ kind: "slides", undo: true }),
);

/**
 * What reads HTML into a page of its own: a browser's `DOMParser`, or
 * linkedom's on the server. Either reads it inert, running nothing and
 * loading nothing, as a deck's HTML may be a bot's. A deck is read from the
 * page's body, and the reader is always handed a whole page, as linkedom
 * finds no body in anything less.
 */
export interface HtmlReader {
	parseFromString(html: string, type: "text/html"): { readonly body: unknown };
}

/** Why a deck's HTML can't be read. */
export type DeckUnreadable =
	/** It holds elements nested deeper than any slide's (`MOST_NESTED_ELEMENTS`), as HTML written to break a reader does. */
	| "nestedTooDeeply"
	/** Some of its words would be lost: the schema finds no place for them. */
	| "wordsLost";

/** What a deck's HTML says, each told apart from the others, so that a caller acts on each. */
export type DeckReading =
	| { readonly outcome: "deck"; readonly deck: Node }
	/** It holds no slide, and nothing a slide could: no words, box, image or shape. */
	| { readonly outcome: "nothing" }
	| { readonly outcome: "unreadable"; readonly reason: DeckUnreadable };

/**
 * What `html`, a deck's HTML, says, read with `reader`: the deck it holds,
 * that it says nothing, or why it can't be read, as for a bot's rewrite of a
 * deck, which is to be refused for either of those rather than make the deck
 * empty or lose some of it.
 *
 * It is forgiving, as bots write it by hand: a doctype or a whole page reads
 * as its body; what says nothing on a slide, as a style or a script, is left
 * out, words and all; an element around slides, as a `<main>`, is read as
 * what it holds, and a slide inside another as one after it; what stands
 * outside every slide goes on a slide of its own, of the `blank` layout;
 * what a slide holds outside its body, as a box after its notes, goes in its
 * body; and what the schema reads forgivingly is in `live-slides.ts`. A
 * suggestion is never read from HTML: one is made in the editor.
 */
export function readDeckHtml(html: string, reader: HtmlReader): DeckReading {
	let page: ElementInPage;
	try {
		page = pageOf(html, reader);
	} catch (error) {
		// Reading elements nested many thousands deep runs out of stack in some readers.
		if (error instanceof RangeError) return { outcome: "unreadable", reason: "nestedTooDeeply" };
		throw error;
	}
	if (nestsDeeperThan(page, MOST_NESTED_ELEMENTS)) {
		return { outcome: "unreadable", reason: "nestedTooDeeply" };
	}
	for (const unsaid of [...page.querySelectorAll(UNSAID)]) unsaid.remove();
	if (!holdsContent(page)) return { outcome: "nothing" };
	withSlidesAtTop(page);
	withLooseContentOnSlides(page);
	for (const slide of [...page.children].filter(isSlide)) tidySlide(slide);
	const deck = withImageLinksAsAttributes(DECK_PARSER.parse(page as unknown as PageForParser));
	if (wordsIn(deck.textContent) !== wordsIn(page.textContent ?? "")) {
		return { outcome: "unreadable", reason: "wordsLost" };
	}
	return { outcome: "deck", deck };
}

/**
 * `html`, a deck's HTML, as the deck to open, read with `reader` (see
 * `readDeckHtml`): one empty title slide when it says nothing, as a new deck
 * is. Throws `UnreadableDeckHtml` when it can't be read, rather than show
 * something other than what it says.
 */
export function deckFromHtml(html: string, reader: HtmlReader): Node {
	const reading = readDeckHtml(html, reader);
	switch (reading.outcome) {
		case "deck":
			return reading.deck;
		case "nothing":
			return DECK_SCHEMA.topNodeType.create(null, newSlide(DECK_SCHEMA, "title"));
		case "unreadable":
			throw new UnreadableDeckHtml(reading.reason);
	}
}

/** A deck's HTML that can't be read (see `DeckUnreadable`). */
export class UnreadableDeckHtml extends Error {
	readonly reason: DeckUnreadable;
	constructor(reason: DeckUnreadable) {
		super(`A deck's HTML can't be read: ${reason}`);
		this.name = "UnreadableDeckHtml";
		this.reason = reason;
	}
}

/**
 * The most elements a deck's HTML may nest one inside another, below its
 * page's body: far more than a slide's boxes, tables, lists and marks nest,
 * and few enough that reading them never runs out of stack.
 */
const MOST_NESTED_ELEMENTS = 100;

/** What says nothing on a slide, words and all: what a page holds besides its body, and what runs or styles one. */
const UNSAID = "head, title, meta, link, base, style, script, noscript, template, object";

/** What a slide can hold that may be without words. */
const CONTENT_ELEMENTS = "section[data-slide], div[data-slide-box], img, svg";

const SLIDE_ELEMENT = "section[data-slide]";

/** A doctype, or the tag of a page's own `<html>`, `<head>` or `<body>`, opening or closing it. */
const PAGE_TAGS = /<!doctype[^>]*>|<\/?(?:html|head|body)(?=[\s/>])[^>]*>/gi;

/**
 * A node of a page read from HTML, as far as reading a deck from it goes.
 * The API reads HTML with a DOM of its own and is built without the
 * browser's types, so a node is typed by the little of it that is used.
 */
interface NodeInPage {
	readonly nodeType: number;
	readonly textContent: string | null;
	readonly ownerDocument: { createElement(name: string): ElementInPage } | null;
	remove(): void;
}

interface ElementInPage extends NodeInPage, StyledElement {
	readonly localName: string;
	readonly childNodes: Iterable<NodeInPage>;
	readonly children: Iterable<ElementInPage>;
	hasAttribute(name: string): boolean;
	setAttribute(name: string, value: string): void;
	matches(selector: string): boolean;
	contains(other: NodeInPage): boolean;
	querySelector(selector: string): ElementInPage | null;
	querySelectorAll(selector: string): Iterable<ElementInPage>;
	insertBefore(node: NodeInPage, before: NodeInPage | null): unknown;
	appendChild(node: NodeInPage): unknown;
	replaceWith(...nodes: NodeInPage[]): void;
	after(...nodes: NodeInPage[]): void;
}

/** The node ProseMirror's parser reads, named through its own type, as the API is built without the browser's. */
type PageForParser = Parameters<ProseMirrorParser["parse"]>[0];

const ELEMENT_NODE = 1;

/**
 * The body of the page `html` is read into: handed to `reader` as a whole
 * page of its own, without its own doctype and page tags (`PAGE_TAGS`), as
 * linkedom reads no further than a doctype inside a body, and a stray
 * `</body>` would end the body before what follows it. What its head held,
 * as its title, is left out with what else says nothing (`UNSAID`).
 */
function pageOf(html: string, reader: HtmlReader): ElementInPage {
	const page = `<!doctype html><html><head></head><body>${html.replace(PAGE_TAGS, "")}</body></html>`;
	const { body } = reader.parseFromString(page, "text/html");
	if (typeof body !== "object" || body === null)
		throw new TypeError("The HTML reader gave no body");
	return body as ElementInPage;
}

/** Whether `page` holds elements more than `most` deep, counted without recursion, as the page may be deep enough to exhaust a stack. */
function nestsDeeperThan(page: ElementInPage, most: number): boolean {
	const waiting = [...page.children].map((element) => ({ element, depth: 1 }));
	for (let next = waiting.pop(); next; next = waiting.pop()) {
		if (next.depth > most) return true;
		for (const child of next.element.children) {
			waiting.push({ element: child, depth: next.depth + 1 });
		}
	}
	return false;
}

/** `text` without its white space, which a deck read from HTML may close up or keep, but holds the same words either way. */
const wordsIn = (text: string) => text.replace(/\s+/g, "");

/** Whether `node` is or holds words, or something a slide could hold that may be without them (`CONTENT_ELEMENTS`). */
function holdsContent(node: NodeInPage): boolean {
	if (wordsIn(node.textContent ?? "") !== "") return true;
	if (node.nodeType !== ELEMENT_NODE) return false;
	const element = node as ElementInPage;
	return element.matches(CONTENT_ELEMENTS) || element.querySelector(CONTENT_ELEMENTS) !== null;
}

const isElement = (node: NodeInPage): node is ElementInPage => node.nodeType === ELEMENT_NODE;
const isSlide = (node: NodeInPage) => isElement(node) && node.matches(SLIDE_ELEMENT);
const isBody = (node: NodeInPage) => isElement(node) && node.matches("div[data-slide-body]");
const isNotes = (node: NodeInPage) => isElement(node) && node.matches("aside[data-speaker-notes]");

/**
 * Puts every slide of `page` among its own children, as the schema holds
 * slides in the deck alone: an element around slides that is no slide, as a
 * `<main>` or a `<div>`, is replaced by what it holds, and the slides inside
 * a slide follow it instead, in order. What stood beside them keeps its
 * place among them.
 */
function withSlidesAtTop(page: ElementInPage): void {
	for (;;) {
		const holder = [...page.children].find((child) => child.querySelector(SLIDE_ELEMENT) !== null);
		if (!holder) return;
		if (!isSlide(holder)) {
			holder.replaceWith(...holder.childNodes);
			continue;
		}
		const outermost: ElementInPage[] = [];
		for (const inner of holder.querySelectorAll(SLIDE_ELEMENT)) {
			if (!outermost.some((slide) => slide.contains(inner))) outermost.push(inner);
		}
		holder.after(...outermost);
	}
}

/**
 * Puts each run of what `page` holds between its slides, as words or blocks
 * written with no slide around them, on a slide of its own, of no layout.
 * The schema finds no place for them outside a slide, as a slide must hold
 * notes as well as its body, and would leave them out. A run holding nothing
 * a slide could, as a line break, makes no slide.
 */
function withLooseContentOnSlides(page: ElementInPage): void {
	const document = page.ownerDocument;
	if (!document) throw new TypeError("A page read from HTML has no document");
	let run: NodeInPage[] = [];
	const endRun = () => {
		const [first] = run;
		if (first && run.some(holdsContent)) {
			const slide = document.createElement("section");
			slide.setAttribute("data-slide", "");
			page.insertBefore(slide, first);
			for (const node of run) slide.appendChild(node);
		}
		run = [];
	};
	for (const child of [...page.childNodes]) {
		if (isSlide(child)) endRun();
		else run.push(child);
	}
	endRun();
}

/**
 * Gives `slide` one body, holding everything the slide holds but its notes,
 * in order, and one set of notes after it, as the schema holds a slide. A
 * bot may write blocks or boxes beside the body, after the notes, or a body
 * or notes twice, and the schema has no place for anything after the notes.
 */
function tidySlide(slide: ElementInPage): void {
	const children = [...slide.childNodes];
	const bodies = children.filter(isBody) as ElementInPage[];
	const [firstNotes, ...moreNotes] = children.filter(isNotes) as ElementInPage[];
	const body = bodies[0] ?? newBody(slide);
	const content = children.flatMap((child) => {
		if (isNotes(child)) return [];
		return isBody(child) ? [...(child as ElementInPage).childNodes] : [child];
	});
	// Each goes to the body's end in turn, so what it holds already moves too and all keep their order.
	for (const node of content) body.appendChild(node);
	for (const extra of bodies.slice(1)) extra.remove();
	for (const notes of moreNotes) {
		for (const node of [...notes.childNodes]) firstNotes?.appendChild(node);
		notes.remove();
	}
	slide.appendChild(body);
	if (firstNotes) slide.appendChild(firstNotes);
}

function newBody(slide: ElementInPage): ElementInPage {
	const document = slide.ownerDocument;
	if (!document) throw new TypeError("A page read from HTML has no document");
	const body = document.createElement("div");
	body.setAttribute("data-slide-body", "");
	return body;
}

const SUGGESTION_MARKS: readonly string[] = [
	SUGGESTED_INSERTION,
	SUGGESTED_DELETION,
	SUGGESTED_MODIFICATION,
];

/** The blocks whose lines are text, outside code, whose spaces HTML closes up. */
const TEXT_BLOCKS: readonly string[] = ["paragraph", "heading"];

const isTagRule = (rule: ParseRule): rule is TagParseRule => typeof rule.tag === "string";

/** The style the deck's HTML keeps a block's spaces by. */
const KEEP_WHITE_SPACE = "white-space: pre-wrap";

/** Whether `element`'s style keeps its spaces as they are. */
const keepsWhiteSpace = (element: StyledElement) =>
	["pre", "pre-wrap", "break-spaces"].includes(
		styleProperty(element, "white-space")?.toLowerCase() ?? "",
	);

/** `rule`, read only from an element that keeps its spaces, keeping them, and before `rule` so it is tried first. */
function keepingWhiteSpace(rule: TagParseRule): TagParseRule {
	return {
		...rule,
		preserveWhitespace: "full",
		getAttrs: (element) => {
			if (!keepsWhiteSpace(element)) return false;
			return rule.getAttrs ? rule.getAttrs(element) : (rule.attrs ?? null);
		},
	};
}

/**
 * A deck's HTML read as its schema reads HTML, but for two things: a
 * suggestion's marks are never read, as a deck's HTML holds none and one
 * written into it would be a forged or broken suggestion; and a paragraph or
 * heading saying `white-space: pre-wrap` (`keepsWhiteSpace`) keeps its spaces
 * as they are, as the deck's HTML writes one whose spaces HTML would close up.
 */
const DECK_PARSER = new ProseMirrorParser(
	DECK_SCHEMA,
	ProseMirrorParser.fromSchema(DECK_SCHEMA).rules.flatMap((rule) => {
		if (rule.mark && SUGGESTION_MARKS.includes(rule.mark)) return [];
		if (isTagRule(rule) && rule.node && TEXT_BLOCKS.includes(rule.node)) {
			return [keepingWhiteSpace(rule), rule];
		}
		return [rule];
	}),
);

/**
 * `deck` with each image's link in its attribute alone. HTML says an image's
 * link as a link around it, which the link's own rule also reads as a mark on
 * the image, where the sync layer would drop it (see `DocumentImage` in
 * `live-document.ts`).
 */
function withImageLinksAsAttributes(deck: Node): Node {
	const link = deck.type.schema.marks.link;
	if (!link) return deck;
	const change = new Transform(deck);
	deck.descendants((node, position) => {
		const mark = node.type.name === "image" ? link.isInSet(node.marks) : undefined;
		if (!mark) return;
		const attributes = {
			...node.attrs,
			link: node.attrs.link ?? mark.attrs.href,
			linkTitle: node.attrs.linkTitle ?? mark.attrs.title,
		};
		change.setNodeMarkup(position, undefined, attributes, mark.removeFromSet(node.marks));
	});
	return change.doc;
}

/** `deck` as HTML (see the top of this file). Throws a `RangeError` for a live document that is no deck. */
export function htmlOfDeck(deck: Node): string {
	if (deck.firstChild?.type.name !== SLIDE) throw new RangeError("Only a deck is written as HTML");
	const serializer = deckSerializer(deck.type.schema);
	const writing = { document: WRITING_PAGE } as unknown as SerializingOptions;
	return deck.children
		.map((slide) => {
			const section = serializer.serializeNode(slide, writing);
			return written(section as unknown as WrittenElement, "");
		})
		.join("\n\n");
}

/** What the serializer is told to write in: named through its own type, as the API is built without the browser's. */
type SerializingOptions = NonNullable<Parameters<DOMSerializer["serializeNode"]>[1]>;

/** `schema`'s serializer, but that a paragraph or heading whose spaces HTML would close up says to keep them (`KEEP_WHITE_SPACE`). */
function deckSerializer(schema: Schema): DOMSerializer {
	const nodes = DOMSerializer.nodesFromSchema(schema);
	for (const name of TEXT_BLOCKS) {
		const toDOM = nodes[name];
		if (!toDOM) continue;
		nodes[name] = (node) =>
			holdsSpaceHtmlClosesUp(node) ? withStyle(toDOM(node), KEEP_WHITE_SPACE) : toDOM(node);
	}
	return new DOMSerializer(nodes, DOMSerializer.marksFromSchema(schema));
}

/**
 * Whether HTML would read `textblock`'s text other than it is, as HTML
 * closes up white space: a tab or a line end, spaces in a row, or a space
 * at the block's start or end, or after a line break.
 */
function holdsSpaceHtmlClosesUp(textblock: Node): boolean {
	/** What the text so far ends with: the start of a line, a space, or anything else. */
	let before: "lineStart" | "space" | "other" = "lineStart";
	for (const child of textblock.children) {
		if (!child.isText) {
			before = child.type.name === "hardBreak" ? "lineStart" : "other";
			continue;
		}
		const text = child.text ?? "";
		if (/[\t\n\r\f]| {2}/.test(text) || (text.startsWith(" ") && before !== "other")) return true;
		before = text.endsWith(" ") ? "space" : "other";
	}
	return before === "space";
}

/** `spec`, an element's, with `declaration` added to its style. */
function withStyle(spec: DOMOutputSpec, declaration: string): DOMOutputSpec {
	if (!Array.isArray(spec)) return spec;
	const [name, first, ...rest] = spec as readonly unknown[];
	const hasAttributes =
		typeof first === "object" && first !== null && !Array.isArray(first) && !("nodeType" in first);
	const attributes: Record<string, unknown> = hasAttributes ? { ...first } : {};
	const style = [attributes.style, declaration].filter(Boolean).join("; ");
	const children = hasAttributes ? rest : [first, ...rest];
	return [name, { ...attributes, style }, ...children] as unknown as DOMOutputSpec;
}

/*
 * The HTML is written by the schema's own serializer, into a page that keeps
 * what it is given as text: as much of a DOM as the serializer builds with.
 * A browser's DOM would rewrite each style in its own words, such as a hex
 * colour as `rgb()`, and the server has no DOM at all.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Fields are declared apart from the constructor: Node, which runs the server, strips types and can't run parameter properties.
class WrittenText {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
}

class WrittenElement {
	readonly attributes = new Map<string, string>();
	readonly children: WrittenNode[] = [];
	/** The element's name, or none for a fragment, whose children go wherever it is put. */
	readonly name: string;
	readonly inSvg: boolean;
	constructor(name: string, inSvg: boolean) {
		this.name = name;
		this.inSvg = inSvg;
	}
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
	}
	setAttributeNS(_namespace: string, name: string, value: unknown) {
		this.setAttribute(name, value);
	}
	appendChild(child: WrittenNode): WrittenNode {
		if (child instanceof WrittenElement && child.name === "") this.children.push(...child.children);
		else this.children.push(child);
		return child;
	}
}

type WrittenNode = WrittenElement | WrittenText;

const WRITING_PAGE = {
	createElement: (name: string) => new WrittenElement(name, false),
	createElementNS: (namespace: string, name: string) =>
		new WrittenElement(name, namespace === SVG_NAMESPACE),
	createTextNode: (text: string) => new WrittenText(text),
	createDocumentFragment: () => new WrittenElement("", false),
};

/** The elements HTML writes without an end. */
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

/** The elements whose children are written on lines of their own: a slide, its body, its boxes and its notes. */
const STRUCTURE_ATTRIBUTES = [
	"data-slide",
	"data-slide-body",
	"data-slide-box",
	"data-speaker-notes",
];

const INDENT = "  ";

function written(node: WrittenNode, indent: string): string {
	if (node instanceof WrittenText) return escaped(node.text, TEXT_ESCAPED);
	const start = `<${node.name}${[...node.attributes].map(attributeText).join("")}`;
	if (node.inSvg && node.children.length === 0) return `${start}/>`;
	if (!node.inSvg && VOID_ELEMENTS.has(node.name)) return `${start}>`;
	const children = childrenWritten(node);
	const end = `</${node.name}>`;
	if (children.length === 0) return `${start}>${end}`;
	if (!STRUCTURE_ATTRIBUTES.some((name) => node.attributes.has(name))) {
		return `${start}>${children.map((child) => written(child, indent)).join("")}${end}`;
	}
	const inner = indent + INDENT;
	const lines = children.map((child) => inner + written(child, inner));
	return `${start}>\n${lines.join("\n")}\n${indent}${end}`;
}

/**
 * The children of `element` as written: a box's blocks without the element
 * they are drawn in, and a slide's notes left out when they are one empty
 * line, as both read back the same without.
 */
function childrenWritten(element: WrittenElement): WrittenNode[] {
	return element.children.flatMap((child) => {
		if (!(child instanceof WrittenElement)) return [child];
		if (child.attributes.has(BOX_CONTENT_ATTRIBUTE)) return child.children;
		return child.attributes.has("data-speaker-notes") && isOneEmptyLine(child) ? [] : [child];
	});
}

const isOneEmptyLine = (notes: WrittenElement) => {
	const [only, ...more] = notes.children;
	return (
		more.length === 0 &&
		only instanceof WrittenElement &&
		only.name === "p" &&
		only.attributes.size === 0 &&
		only.children.length === 0
	);
};

/** An attribute as HTML writes it: alone when empty, and otherwise in quotes, single ones when its value holds double ones. */
function attributeText([name, value]: [string, string]): string {
	if (value === "") return ` ${name}`;
	if (value.includes('"') && !value.includes("'")) {
		return ` ${name}='${escaped(value, IN_SINGLE_QUOTES_ESCAPED)}'`;
	}
	return ` ${name}="${escaped(value, IN_DOUBLE_QUOTES_ESCAPED)}"`;
}

/** A no-break space, which is written `&nbsp;` so that it can be told from a space. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** What is escaped in text, in an attribute in single quotes, and in one in double quotes. */
const TEXT_ESCAPED = new RegExp(`[&<>${NO_BREAK_SPACE}]`, "g");
const IN_SINGLE_QUOTES_ESCAPED = new RegExp(`[&${NO_BREAK_SPACE}]`, "g");
const IN_DOUBLE_QUOTES_ESCAPED = new RegExp(`[&"${NO_BREAK_SPACE}]`, "g");

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	[NO_BREAK_SPACE]: "&nbsp;",
};

const escaped = (text: string, characters: RegExp) =>
	text.replace(characters, (character) => ESCAPES[character] ?? character);
