import { addSuggestionMarks } from "@handlewithcare/prosemirror-suggest-changes";
import { Extension, type Extensions, Mark, type MarkConfig, mergeAttributes } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Highlight } from "@tiptap/extension-highlight";
import { Image, type ImageOptions } from "@tiptap/extension-image";
import { isAllowedUri, Link } from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Underline } from "@tiptap/extension-underline";
import {
	type DOMOutputSpec,
	Fragment,
	type MarkType,
	type Node,
	type NodeType,
	type Slice,
	type Mark as SuggestionMarkOnNode,
} from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";
import { StarterKit } from "@tiptap/starter-kit";
import type { LiveArtifactKind } from "./artifacts.ts";
import { LINE_BREAK_TAG, MARK_HTML_TAGS, type MarkWrittenAsHtml } from "./document-markdown.ts";
import { type ArtifactImageIds, ownImageAt } from "./http/artifact-images.ts";
import {
	Deck,
	SLIDE,
	SLIDE_BODY,
	SLIDE_BOX,
	Slide,
	SlideBody,
	SlideBox,
	SPEAKER_NOTES,
	SpeakerNotes,
} from "./live-slides.ts";
import { slideTextStyles } from "./slide-text-style.ts";

/*
 * What a live document holds, for the two places that hold one: the editor in
 * the web app and the API's copy that agents change. They sync node by node,
 * so anything one side's schema lacks is dropped on its way through. Both
 * build their schema from here, for the kind of artifact the document is: a
 * `document`'s blocks, or a `slides` deck's slides holding those same blocks
 * (see `live-slides.ts`).
 */

/** Marks content somebody proposes adding, which is not part of the document until it is accepted. */
export const SUGGESTED_INSERTION = "insertion";

/** Marks content somebody proposes removing, which stays part of the document until that is accepted. */
export const SUGGESTED_DELETION = "deletion";

/**
 * Marks a block whose kind or formatting somebody proposes changing, or a
 * slide whose layout they do: what is proposed is what the block holds, and
 * the mark keeps what it would replace.
 */
export const SUGGESTED_MODIFICATION = "modification";

/*
 * The marks are the suggesting library's own, which its commands for making,
 * accepting and reverting a suggestion look up by name. They are declared to
 * the editor as its marks, with the library's rules for how each is drawn and
 * what it excludes.
 */
const suggestionSpecs = addSuggestionMarks({});

type SuggestionMarkName = keyof typeof suggestionSpecs;

const suggestionMark = (name: SuggestionMarkName) =>
	Mark.create({
		name,
		// Typing at its edge is new text of its own, not more of the suggestion.
		inclusive: false,
		excludes: suggestionSpecs[name].excludes,
		addAttributes() {
			return Object.fromEntries(
				Object.keys(suggestionSpecs[name].attrs ?? {}).map((attribute) => [
					attribute,
					{ default: null },
				]),
			);
		},
	});

const SuggestionSchema = Extension.create({
	name: "suggestionSchema",
	extendMarkSchema(extension) {
		const spec = suggestionSpecs[extension.name as SuggestionMarkName];
		return spec ? { toDOM: spec.toDOM, parseDOM: spec.parseDOM } : {};
	},
	addGlobalAttributes() {
		return [
			{
				types: NODES_SUGGESTED_WHOLE,
				attributes: {
					// Never read from HTML, which anybody may write: a suggestion is made in the editor.
					[NODE_SUGGESTION]: { default: null, rendered: false, parseHTML: () => null },
				},
			},
		];
	},
});

/*
 * A suggestion on a whole node, such as a block or an image, is a mark on the
 * node, and the sync layer carries marks on text only. So each such node also
 * says what is suggested for it in an attribute, which the sync layer does
 * carry. The two are kept the same: whoever changes the marks writes the
 * attribute (`suggestionsAsAttributes`), and whoever receives the attribute
 * restores the marks from it (`suggestionsFromAttributes`).
 */

/** The attribute a node says its own suggestion marks in, as JSON, or `null` with none. */
export const NODE_SUGGESTION = "suggestion";

/**
 * The nodes a suggestion can add, remove or change whole: the blocks, a
 * deck's slides and the parts of one, and the nodes in a line of text that
 * aren't text, an image and a line break.
 */
const NODES_SUGGESTED_WHOLE = [
	SLIDE,
	SLIDE_BODY,
	SLIDE_BOX,
	SPEAKER_NOTES,
	"paragraph",
	"heading",
	"blockquote",
	"bulletList",
	"orderedList",
	"listItem",
	"codeBlock",
	"horizontalRule",
	"table",
	"tableRow",
	"tableHeader",
	"tableCell",
	"image",
	"hardBreak",
];

const isSuggestionMark = (mark: SuggestionMarkOnNode) => mark.type.name in suggestionSpecs;

/** What is suggested for the node itself, as its attribute says it: `null` when nothing is. */
export function nodeSuggestion(node: Node): string | null {
	const marks = node.marks.filter(isSuggestionMark);
	return marks.length === 0 ? null : JSON.stringify(marks.map((mark) => mark.toJSON()));
}

/**
 * The suggestion marks a node's attribute says it has: none when it says
 * anything but a list of the suggesting library's marks, as `nodeSuggestion`
 * writes one. The attribute arrives through the sync layer from any tab, so
 * nothing it says may stop the document being read.
 */
export function marksOfNodeSuggestion(node: Node): SuggestionMarkOnNode[] {
	const said: unknown = node.attrs[NODE_SUGGESTION];
	const marks = typeof said === "string" ? jsonIn(said) : undefined;
	if (!Array.isArray(marks) || !marks.every(isSuggestionMarkJson)) return [];
	try {
		return marks.map((mark) => node.type.schema.markFromJSON(mark));
	} catch (error) {
		// A mark missing an attribute its type requires, as a modification's kind.
		if (error instanceof RangeError) return [];
		throw error;
	}
}

/** What `text` says as JSON, or `undefined` when it isn't JSON. */
function jsonIn(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** Whether `value` is one of the suggesting library's marks as JSON: its name, and an id the library takes, a string or a number. */
function isSuggestionMarkJson(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const { type, attrs } = value as { type?: unknown; attrs?: unknown };
	if (typeof type !== "string" || !(type in suggestionSpecs)) return false;
	const id =
		typeof attrs === "object" && attrs !== null ? (attrs as { id?: unknown }).id : undefined;
	return typeof id === "string" || typeof id === "number";
}

/** Whether the node is of a kind that says its suggestion in an attribute. */
export const saysNodeSuggestion = (node: Node) => !node.isText && NODE_SUGGESTION in node.attrs;

/**
 * Whether a suggestion waits on `node` itself or on anything in it, which a
 * change that replaces the node, such as deleting a box or redrawing it in a
 * new layout, would lose.
 */
export function holdsSuggestion(node: Node): boolean {
	let holds = node.marks.some(isSuggestionMark);
	node.descendants((child) => {
		holds ||= child.marks.some(isSuggestionMark);
		return !holds;
	});
	return holds;
}

/** The document with every node's attribute saying the suggestion marks the node has, to send. */
export const suggestionsAsAttributes = (document: Node): Node =>
	everyNodeSayingSuggestion(document, (node, content) =>
		node.type.create(
			{ ...node.attrs, [NODE_SUGGESTION]: nodeSuggestion(node) },
			content,
			node.marks,
		),
	);

/** The document with every node marked as its attribute says, as received. */
export const suggestionsFromAttributes = (document: Node): Node =>
	everyNodeSayingSuggestion(document, (node, content) =>
		node.type.create(node.attrs, content, [
			...node.marks.filter((mark) => !isSuggestionMark(mark)),
			...marksOfNodeSuggestion(node),
		]),
	);

/** `node` with `change` made to every node in it that says its suggestion in an attribute. */
function everyNodeSayingSuggestion(
	node: Node,
	change: (node: Node, content: Fragment) => Node,
): Node {
	if (node.isText) return node;
	const content = Fragment.fromArray(
		node.content.content.map((child) => everyNodeSayingSuggestion(child, change)),
	);
	return saysNodeSuggestion(node) ? change(node, content) : node.copy(content);
}

/**
 * A block suggested whole, such as a new list item or a paragraph to remove,
 * carries the suggestion's mark itself, which the block holding it must
 * allow. These are the blocks that hold other blocks, each allowing that. (A
 * paragraph allows any mark on the text and images in it already.)
 */
const SUGGESTIONS_ON_CHILDREN = {
	marks: [SUGGESTED_INSERTION, SUGGESTED_MODIFICATION, SUGGESTED_DELETION].join(" "),
};

/**
 * A list item, as the standard one, read and written so that its markdown
 * reads back as it was. An empty item in a bulleted list is written as its
 * bullet alone, `-`: markdown reads a bullet followed only by a space as
 * text, not as the start of a list. A task's box, `[ ]` or `[x]`, is read as
 * the characters it is at the start of the item's words (see `TaskBoxAsText`),
 * as a live document has no boxes to tick.
 */
const DocumentListItem = ListItem.extend({
	parseMarkdown(token, helpers) {
		const [first, second, ...rest] = token.tokens ?? [];
		const tokens =
			first?.type === "checkbox" && second?.type === "text"
				? [{ ...second, tokens: [first, ...(second.tokens ?? [])] }, ...rest]
				: token.tokens;
		return this.parent?.({ ...token, tokens }, helpers) ?? [];
	},
	renderMarkdown(node, helpers, context) {
		const written: string = this.parent?.(node, helpers, context) ?? "";
		return written.replace(BULLET_ALONE, "-");
	},
});

/** A bullet starting an item with nothing after it but a space. */
const BULLET_ALONE = /^- (?=\n|$)/;

/** Reads a task's box among an item's words as its characters, `[ ] ` or `[x] `. */
const TaskBoxAsText = Extension.create({
	name: "taskBoxAsText",
	markdownTokenName: "checkbox",
	parseMarkdown: (token, helpers) => (token.raw ? helpers.createTextNode(token.raw) : []),
});

const blocksHoldingBlocks = [
	Blockquote,
	BulletList,
	OrderedList,
	DocumentListItem,
	TableRow,
	TableHeader,
	TableCell,
].map((node) => node.extend(SUGGESTIONS_ON_CHILDREN));

/**
 * What each kind of live document is made of beyond the blocks they share,
 * each node holding others allowing them a suggestion's marks too: a
 * document's top, which holds blocks, or a deck's, which holds slides, with
 * the parts of a slide and the styles its text may have.
 */
const KIND_NODES: Record<LiveArtifactKind, Extensions> = {
	document: [Document.extend(SUGGESTIONS_ON_CHILDREN)],
	slides: [
		...[Deck, Slide, SlideBody, SlideBox, SpeakerNotes].map((node) =>
			node.extend(SUGGESTIONS_ON_CHILDREN),
		),
		...slideTextStyles,
	],
};

/** A table, which holds rows and allows them a suggestion's marks too. */
const LiveTable = Table.extend(SUGGESTIONS_ON_CHILDREN);

/**
 * Each kind's table: a document's in a wrapper that scrolls sideways when it
 * is wider than the page, and a slide's as wide as its box, in none.
 */
const KIND_TABLES: Record<LiveArtifactKind, typeof LiveTable> = {
	document: LiveTable.configure({ renderWrapper: true }),
	slides: LiveTable.configure({ renderWrapper: false }),
};

/*
 * The marks markdown has no sign for are written as their HTML tags, and a
 * table cell's lines are joined by `<br>` (see `document-markdown.ts`).
 */

/**
 * Writes a mark as its HTML tag, `<tag>…</tag>`, and reads it back: the token
 * is the text up to the first closing tag outside a code span.
 */
const markWrittenAsHtmlTag = (
	markName: MarkWrittenAsHtml,
): Pick<MarkConfig, "renderMarkdown" | "parseMarkdown" | "markdownTokenizer"> => {
	const tag = MARK_HTML_TAGS[markName];
	return {
		renderMarkdown: (node, helpers) =>
			`<${tag}>${helpers.renderChildren(node.content ?? [])}</${tag}>`,
		parseMarkdown: (token, helpers) =>
			helpers.applyMark(markName, helpers.parseInline(token.tokens ?? [])),
		markdownTokenizer: {
			name: markName,
			level: "inline",
			start: (source) => source.toLowerCase().indexOf(`<${tag}>`),
			tokenize(source, _tokens, lexer) {
				const opening = `<${tag}>`;
				if (!source.toLowerCase().startsWith(opening)) return undefined;
				// What can stand before the closing tag without being it: an escaped character, or a code span's backticks.
				const delimiters = new RegExp(`\\\\[\\s\\S]|\`+|</${tag}>`, "gi");
				delimiters.lastIndex = opening.length;
				for (let match = delimiters.exec(source); match; match = delimiters.exec(source)) {
					if (match[0].startsWith("\\")) continue;
					if (match[0].startsWith("`")) {
						const codeSpan = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(source.slice(match.index));
						if (codeSpan) delimiters.lastIndex = match.index + codeSpan[0].length;
						continue;
					}
					const text = source.slice(opening.length, match.index);
					if (!text) return undefined;
					return {
						type: markName,
						raw: source.slice(0, delimiters.lastIndex),
						text,
						tokens: lexer.inlineTokens(text),
					};
				}
				return undefined;
			},
		},
	};
};

/** The marks written as HTML tags, by name: one for each tag the markdown may hold. */
const MARKS_WRITTEN_AS_HTML = {
	underline: Underline,
	superscript: Superscript,
	subscript: Subscript,
	highlight: Highlight,
} satisfies Record<MarkWrittenAsHtml, Mark>;

const marksWrittenAsHtml = (Object.keys(MARK_HTML_TAGS) as MarkWrittenAsHtml[]).map((name) =>
	(MARKS_WRITTEN_AS_HTML[name] as Mark).extend(markWrittenAsHtmlTag(name)),
);

/**
 * Reads `<br>` in the markdown as a hard break. The table extension writes
 * one between the lines of a cell, as a row of a markdown table is one line.
 */
const LineBreakTag = Extension.create({
	name: "lineBreakTag",
	markdownTokenizer: {
		name: "lineBreakTag",
		level: "inline",
		start: (source) => source.toLowerCase().indexOf("<br"),
		tokenize: (source) => {
			const [raw] = LINE_BREAK_TAG.exec(source) ?? [];
			return raw ? { type: "lineBreakTag", raw } : undefined;
		},
	},
	parseMarkdown: () => ({ type: "hardBreak" }),
});

/** A document's own images: the artifact that keeps them, and where the page loads one from. */
export interface OwnImages {
	/** The artifact whose kept images the document shows. Any other image is drawn as its words. */
	artifact: { podId: string; artifactId: string };
	/** Where the page fetches one of the artifact's images from, as the API may be on another origin. */
	source: (ids: ArtifactImageIds) => string;
}

/**
 * A link, as the editor's standard one is, that also hands its address to an
 * image inside it when read from markdown, as `[![words](address)](link)`
 * (see `DocumentImage`). It opens nothing when clicked. Bots write documents
 * too, so the web app handles a click on a link in one as it does on a bot's
 * link in a message, and asks before the link leaves the app.
 */
const DocumentLink = Link.extend({
	addAttributes() {
		const attributes = this.parent?.() ?? {};
		return {
			...attributes,
			// An empty class says none, and linkedom, which reads HTML on the server, gives one for a link without.
			class: { ...attributes.class, parseHTML: (element) => element.getAttribute("class") || null },
		};
	},
	parseMarkdown: (token, helpers) => {
		const link = { href: token.href, title: token.title || null };
		const content = helpers
			.parseInline(token.tokens ?? [])
			.map((node) =>
				node.type === "image"
					? { ...node, attrs: { ...node.attrs, link: link.href, linkTitle: link.title } }
					: node,
			);
		return helpers.applyMark("link", content, link);
	},
}).configure({ openOnClick: false });

const LINK_OPTIONS = DocumentLink.options;

/** Whether a text link may go to `href`, as the link extension decides. */
export const linkMayGoTo = (href: string) =>
	LINK_OPTIONS.isAllowedUri(href, {
		defaultValidate: (url) => !!isAllowedUri(url, LINK_OPTIONS.protocols),
		protocols: LINK_OPTIONS.protocols,
		defaultProtocol: LINK_OPTIONS.defaultProtocol,
	});

/** An element of a page being read, as far as finding what holds it goes. */
interface ElementInPage {
	closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/** The link around `image` in a page, when it goes somewhere a text link may. */
function linkAround(image: ElementInPage) {
	const anchor = image.closest("a[href]");
	const href = anchor?.getAttribute("href");
	return anchor && href && linkMayGoTo(href) ? anchor : undefined;
}

/** The attribute an image is drawn with that holds its address as the document keeps it. */
const ADDRESS_ATTRIBUTE = "data-address";

/**
 * An image the document shows: its address, the words that say what it
 * shows, its title, and the link around it with that link's title, as
 * markdown's `[![words](address "title")](link "title")` holds. It sits in
 * the text, as markdown's does, so an image anywhere markdown can put one,
 * such as in a table cell or beside words, is one the document can hold.
 *
 * Only an image of the document's own is loaded. An image anywhere else would
 * be fetched by everyone who opens the document, telling that address
 * whatever a bot led by planted instructions put in it, so it is drawn with no
 * source, as its words. Either way it carries its address, so copying and
 * pasting it keeps the address it had.
 *
 * Its link is an attribute, not a link's mark: the sync layer carries a mark
 * on text only, as with a suggestion on a whole node. It is drawn as a text
 * link is, so a click on it does what one on a text link does, and a link
 * that goes nowhere a text link may is drawn going nowhere, as a text link's
 * is. In the editor, a link's mark that lands on an image becomes its link
 * (`imageLinksAsAttributes`).
 */
const DocumentImage = Image.extend<ImageOptions & { ownImages: OwnImages | undefined }>({
	addOptions() {
		return { ...(this.parent?.() as ImageOptions), ownImages: undefined };
	},
	addAttributes: () => ({
		// The address it was drawn with, which may be where the page loads it from instead, or none.
		src: {
			default: null,
			parseHTML: (element) =>
				element.getAttribute(ADDRESS_ATTRIBUTE) ?? element.getAttribute("src"),
		},
		alt: { default: null },
		title: { default: null },
		link: {
			default: null,
			parseHTML: (element) => linkAround(element)?.getAttribute("href") ?? null,
		},
		linkTitle: {
			default: null,
			parseHTML: (element) => linkAround(element)?.getAttribute("title") ?? null,
		},
	}),
	parseHTML() {
		return [{ tag: `img[${ADDRESS_ATTRIBUTE}]` }, ...(this.parent?.() ?? [])];
	},
	renderHTML({ node }) {
		const { src, alt, title, link, linkTitle } = node.attrs as Record<
			"src" | "alt" | "title" | "link" | "linkTitle",
			string | null
		>;
		const { ownImages } = this.options;
		const own = src && ownImages ? ownImageAt(src, ownImages.artifact) : undefined;
		const drawn = { alt, title, [ADDRESS_ATTRIBUTE]: src };
		const image: DOMOutputSpec = [
			"img",
			own && ownImages ? { ...drawn, src: ownImages.source(own) } : drawn,
		];
		if (!link) return image;
		const anchor = { href: linkMayGoTo(link) ? link : "", title: linkTitle };
		return ["a", mergeAttributes(LINK_OPTIONS.HTMLAttributes, anchor), image];
	},
	renderMarkdown(node, helpers, context) {
		const image: string = this.parent?.(node, helpers, context) ?? "";
		const { link, linkTitle } = (node.attrs ?? {}) as Record<"link" | "linkTitle", string | null>;
		if (!link) return image;
		return linkTitle ? `[${image}](${link} "${linkTitle}")` : `[${image}](${link})`;
	},
	addProseMirrorPlugins() {
		return [imageLinksAsAttributes(this.type)];
	},
});

/**
 * Keeps an image's link in its attribute, never as a link's mark on it,
 * which the sync layer would drop: a link put on text that holds an image,
 * as by pasting a linked image or linking a selection, becomes the image's
 * link, and a link taken off such text is taken off the image too.
 */
function imageLinksAsAttributes(image: NodeType): Plugin {
	return new Plugin({
		key: new PluginKey("imageLinksAsAttributes"),
		appendTransaction(transactions, _before, state) {
			const link = state.schema.marks.link;
			if (!link) return null;
			const { linking, unlinked } = linkChanges(transactions, image, link);
			if (!linking && unlinked.length === 0) return null;
			const change = state.tr;
			const relink = (node: Node, position: number, mark: ReturnType<MarkType["isInSet"]>) =>
				change.setNodeMarkup(
					position,
					undefined,
					{ ...node.attrs, link: mark?.attrs.href ?? null, linkTitle: mark?.attrs.title ?? null },
					mark ? mark.removeFromSet(node.marks) : node.marks,
				);
			for (const { from, to } of unlinked) {
				state.doc.nodesBetween(from, to, (node, position) => {
					if (node.type === image && node.attrs.link && !link.isInSet(node.marks)) {
						relink(node, position, undefined);
					}
				});
			}
			if (linking) {
				state.doc.descendants((node, position) => {
					const mark = node.type === image ? link.isInSet(node.marks) : undefined;
					if (mark) relink(node, position, mark);
				});
			}
			return change.docChanged ? change : null;
		},
	});
}

/**
 * Whether `transactions` may have put a link's mark on an image, and where in
 * the document they leave it each took links off text: from the first text
 * it unlinked to the last, as an image between them, which carries no mark,
 * was unlinked with them, as when unlinking a selection holding it.
 */
function linkChanges(
	transactions: readonly Transaction[],
	image: NodeType,
	link: MarkType,
): { linking: boolean; unlinked: { from: number; to: number }[] } {
	let linking = false;
	const unlinked: { from: number; to: number }[] = [];
	transactions.forEach((transaction, index) => {
		const later = transactions.slice(index + 1).flatMap(({ mapping }) => mapping.maps);
		const positions: number[] = [];
		transaction.steps.forEach((step, stepIndex) => {
			if (step instanceof AddMarkStep && step.mark.type === link) linking = true;
			if (step instanceof ReplaceStep && holdsLinkedImage(step.slice, image, link)) linking = true;
			if (step instanceof RemoveMarkStep && step.mark.type === link) {
				const after = new Mapping([...transaction.mapping.maps.slice(stepIndex + 1), ...later]);
				positions.push(after.map(step.from, 1), after.map(step.to, -1));
			}
		});
		if (positions.length > 0) {
			unlinked.push({ from: Math.min(...positions), to: Math.max(...positions) });
		}
	});
	return { linking, unlinked };
}

function holdsLinkedImage(slice: Slice, image: NodeType, link: MarkType): boolean {
	let holds = false;
	slice.content.descendants((node) => {
		if (node.type === image && link.isInSet(node.marks)) holds = true;
		return !holds;
	});
	return holds;
}

/**
 * A paragraph, which keeps an image alone on its line in the text (the
 * standard one lifts it out to stand as a block, which an image here isn't),
 * and writes a line of its words that markdown would read as a rule, or as
 * the underline making the line above it a heading, with its first character
 * escaped. Written as it is, a line of `---` in a document would become a
 * rule.
 */
const DocumentParagraph = Paragraph.extend({
	parseMarkdown(token, helpers) {
		const [first, ...rest] = token.tokens ?? [];
		if (first?.type === "image" && rest.length === 0) {
			return helpers.createNode("paragraph", undefined, helpers.parseInline([first]));
		}
		return this.parent?.(token, helpers) ?? [];
	},
	renderMarkdown(node, helpers, context) {
		const written: string = this.parent?.(node, helpers, context) ?? "";
		return written
			.split("\n")
			.map((line) => line.replace(RULE_OR_UNDERLINE, "$1\\"))
			.join("\n");
	},
});

/**
 * The start of a line of one character, `-`, `*`, `_` or `=`, repeated with
 * any spaces between, which markdown reads as a rule or an underline: the
 * first group is the indent before it.
 */
const RULE_OR_UNDERLINE = /^([ \t]*)(?=([-*_=])(?:[ \t]*\2)*[ \t]*$)/;

/**
 * A heading, as the standard one, but written as its marks alone, such as
 * `##`, when it holds nothing, where the standard one writes nothing at all
 * and so is gone when its markdown is read back.
 */
const DocumentHeading = Heading.extend({
	renderMarkdown(node, helpers, context) {
		if ((node.content ?? []).length > 0) return this.parent?.(node, helpers, context) ?? "";
		return "#".repeat(Number(node.attrs?.level ?? 1));
	},
});

/**
 * The editor's standard nodes and marks, but for the blocks and the link
 * declared above in their place. The line that shows where something dragged
 * will land is left to the editor, which draws its own.
 */
const standardKit = {
	document: false,
	paragraph: false,
	heading: false,
	blockquote: false,
	bulletList: false,
	orderedList: false,
	listItem: false,
	underline: false,
	link: false,
	dropcursor: false,
} as const;

/** What each kind leaves out of the standard kit: a slide holds no horizontal rule, as a line on a slide is a shape. */
const KIND_KIT: Record<LiveArtifactKind, { horizontalRule?: false }> = {
	document: {},
	slides: { horizontalRule: false },
};

/**
 * The nodes and marks of a live document of `kind`. The editor passes
 * `undo: false`, because its collaboration extension brings an undo that only
 * takes back the person's own changes, and the document's `ownImages`,
 * without which no image is loaded, as on the API, which draws none.
 */
export const liveDocumentExtensions = ({
	kind,
	undo,
	ownImages,
}: {
	kind: LiveArtifactKind;
	undo: boolean;
	ownImages?: OwnImages;
}): Extensions => [
	StarterKit.configure({
		...standardKit,
		...KIND_KIT[kind],
		...(undo ? {} : { undoRedo: false as const }),
	}),
	...KIND_NODES[kind],
	...blocksHoldingBlocks,
	KIND_TABLES[kind],
	DocumentParagraph,
	DocumentHeading,
	TaskBoxAsText,
	DocumentLink,
	DocumentImage.configure({ inline: true, ownImages }),
	...marksWrittenAsHtml,
	LineBreakTag,
	suggestionMark(SUGGESTED_INSERTION),
	suggestionMark(SUGGESTED_DELETION),
	suggestionMark(SUGGESTED_MODIFICATION),
	SuggestionSchema,
];

/** Who made a suggestion: a person in the document, or an agent asked for an edit. */
export interface SuggestionBy {
	kind: "person" | "agent";
	name: string;
}

/**
 * The id of a new suggestion, which every mark of it carries. It says who
 * made it, since the marks have nowhere else to: `unique` first, which holds
 * no colon, then the kind, then the name, which may.
 */
export const suggestionId = (unique: string, by: SuggestionBy): string =>
	`${unique}:${by.kind}:${by.name}`;

/** Who made the suggestion with this id. Nobody known, for an id made elsewhere. */
export function suggestionBy(id: unknown): SuggestionBy {
	const [, kind, ...name] = typeof id === "string" ? id.split(":") : [];
	return kind === "person" || kind === "agent"
		? { kind, name: name.join(":") }
		: { kind: "person", name: "Someone" };
}

/**
 * Which nodes and marks a live document of either kind holds, and the shape
 * of each attribute's value, as a number that goes up whenever either
 * changes. The sync layer deletes whatever its own schema cannot hold, and an
 * editor reads an attribute of another shape as none, so a browser tab built
 * for another number, such as one left open across an update, must not join:
 * it would delete or write over what newer tabs wrote.
 */
export const LIVE_DOCUMENT_SCHEMA = 9;

/** The shared type holding the document's content, which the editor's collaboration extension binds to. */
export const LIVE_DOCUMENT_CONTENT = "default";

/**
 * The shared map of the edits people asked a bot for from inside the
 * document, by the id of the thread each request started. A bot working in
 * one of those threads suggests its changes, for the people in the document
 * to accept or reject. Anywhere else, it makes them.
 */
export const LIVE_DOCUMENT_EDIT_REQUESTS = "editRequests";

/** An edit somebody asked a bot for from inside the document. */
export interface EditRequest {
	/** What they asked for, in their words. */
	instruction: string;
	/** The bot they asked, by name. */
	agent: string;
	/** Whether the bot has suggested a change for it yet. */
	answered: boolean;
}
