import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node, type Schema } from "@tiptap/pm/model";
import type { LiveArtifactKind } from "./artifacts.ts";
import {
	DECK_SCHEMA,
	type DeckReading,
	deckFromHtml,
	type HtmlReader,
	htmlOfDeck,
	readDeckHtml,
} from "./deck-html.ts";
import { liveDocumentExtensions } from "./live-document.ts";
import { SLIDE } from "./live-slides.ts";
import { withValidContent } from "./valid-content.ts";

/*
 * A live document as text, the form it is kept in outside the editor: every
 * version is a snapshot of it, and agents read and rewrite it. A document's
 * text is markdown, and a deck's is HTML (see `deck-html.ts`). The API's copy
 * of a live document converts with these, and so does anything standing in
 * for it.
 */

const DOCUMENT_EXTENSIONS = liveDocumentExtensions({ kind: "document", undo: true });
const DOCUMENT_SCHEMA = getSchema(DOCUMENT_EXTENSIONS);
const DOCUMENT_MARKDOWN = new MarkdownManager({ extensions: DOCUMENT_EXTENSIONS });

/** The schema a live document of `kind` has outside the editor, with the editor's nodes and marks. */
export const liveDocumentSchema = (kind: LiveArtifactKind): Schema =>
	kind === "slides" ? DECK_SCHEMA : DOCUMENT_SCHEMA;

/**
 * `text`, the text of an artifact of `kind`, as the live document to open: a
 * document's markdown (`documentFromMarkdown`), or a deck's HTML, read with
 * `reader` (`deckFromHtml`), which throws `UnreadableDeckHtml` when it can't
 * be read.
 */
export const liveDocumentFromText = (
	kind: LiveArtifactKind,
	text: string,
	reader: HtmlReader,
): Node => (kind === "slides" ? deckFromHtml(text, reader) : documentFromMarkdown(text));

/**
 * What `text`, the text an agent wrote in place of a live document of `kind`,
 * says, told apart so that a rewrite which would empty the document or lose
 * some of what it says is refused: the document, or, for a deck's HTML, that
 * it says nothing or can't be read (see `readDeckHtml`). A document's
 * markdown always reads as a document.
 */
export type LiveDocumentReading =
	| { readonly outcome: "read"; readonly document: Node }
	| Exclude<DeckReading, { readonly outcome: "deck" }>;

export function readLiveDocumentText(
	kind: LiveArtifactKind,
	text: string,
	reader: HtmlReader,
): LiveDocumentReading {
	if (kind === "document") return { outcome: "read", document: documentFromMarkdown(text) };
	const reading = readDeckHtml(text, reader);
	return reading.outcome === "deck" ? { outcome: "read", document: reading.deck } : reading;
}

/** The live document as text, as its kind is written, which its schema says: a document as markdown, a deck as HTML. */
export const textOfLiveDocument = (document: Node): string =>
	liveDocumentKind(document) === "slides" ? htmlOfDeck(document) : markdownOfDocument(document);

/**
 * `markdown`, a `document` artifact's, as a live document, always one its
 * schema holds, whatever `markdown` says: what the schema has no place for is
 * made to fit (see `withValidContent`). Should what was read still not fit,
 * each line of `markdown` is read as a paragraph of its characters instead,
 * so that the editor can show it and none of it is lost.
 */
export function documentFromMarkdown(markdown: string): Node {
	try {
		const read = withValidContent(
			Node.fromJSON(DOCUMENT_SCHEMA, DOCUMENT_MARKDOWN.parse(markdown)),
		);
		read.check();
		return read;
	} catch {
		const lines = { type: "doc", content: linesAsParagraphs(markdown) };
		return withValidContent(Node.fromJSON(DOCUMENT_SCHEMA, lines));
	}
}

const linesAsParagraphs = (text: string): JSONContent[] =>
	text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));

/** `document`, a live `document`, as markdown. Throws a `RangeError` for a deck, which is written as HTML. */
export function markdownOfDocument(document: Node): string {
	if (liveDocumentKind(document) !== "document") {
		throw new RangeError("Only a document is written as markdown");
	}
	return DOCUMENT_MARKDOWN.serialize(document.toJSON());
}

/** The kind of live document `document` is, which its schema says. */
export const liveDocumentKind = (document: Node): LiveArtifactKind =>
	SLIDE in document.type.schema.nodes ? "slides" : "document";
