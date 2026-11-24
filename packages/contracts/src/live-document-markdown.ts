import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node, type Schema } from "@tiptap/pm/model";
import type { LiveArtifactKind } from "./artifacts.ts";
import { liveDocumentExtensions } from "./live-document.ts";
import { deckFromParsedMarkdown, SLIDE } from "./live-slides.ts";
import { withValidContent } from "./valid-content.ts";

/*
 * A live document as markdown, the form it is kept in: every version is a
 * snapshot of it, and agents read and rewrite it. The API's copy of a live
 * document converts with these, and so does anything standing in for it.
 */

/** How a kind of live document is held outside the editor, and read from markdown and written as it. */
interface MarkdownForm {
	schema: Schema;
	markdown: MarkdownManager;
	/** The live document what the markdown reader made of its markdown says. */
	fromParsed: (parsed: JSONContent, schema: Schema) => Node;
}

function formOf(kind: LiveArtifactKind, fromParsed: MarkdownForm["fromParsed"]): MarkdownForm {
	const extensions = liveDocumentExtensions({ kind, undo: true });
	return {
		schema: getSchema(extensions),
		markdown: new MarkdownManager({ extensions }),
		fromParsed,
	};
}

const FORMS: Record<LiveArtifactKind, MarkdownForm> = {
	document: formOf("document", (parsed, schema) => withValidContent(Node.fromJSON(schema, parsed))),
	slides: formOf("slides", deckFromParsedMarkdown),
};

/** The schema a live document of `kind` has outside the editor, with the editor's nodes and marks. */
export const liveDocumentSchema = (kind: LiveArtifactKind): Schema => FORMS[kind].schema;

/**
 * `text`, the markdown of an artifact of `kind`, as a live document, always
 * one its schema holds, whatever `text` says: what the schema has no place
 * for is made to fit (see `withValidContent`). Should what was read still not
 * fit, each line of `text` is read as a paragraph of its characters instead,
 * so that the editor can show it and none of it is lost.
 */
export function liveDocumentFromMarkdown(kind: LiveArtifactKind, text: string): Node {
	const { schema, markdown, fromParsed } = FORMS[kind];
	try {
		const read = fromParsed(markdown.parse(text), schema);
		read.check();
		return read;
	} catch {
		return fromParsed({ type: "doc", content: linesAsParagraphs(text) }, schema);
	}
}

const linesAsParagraphs = (text: string): JSONContent[] =>
	text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));

/** The live document as markdown, written as its kind is, which its schema says. */
export const markdownOfLiveDocument = (document: Node): string =>
	FORMS[liveDocumentKind(document)].markdown.serialize(document.toJSON());

/** The kind of live document `document` is, which its schema says. */
export const liveDocumentKind = (document: Node): LiveArtifactKind =>
	SLIDE in document.type.schema.nodes ? "slides" : "document";
