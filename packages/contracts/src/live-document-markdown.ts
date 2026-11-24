import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { liveDocumentExtensions } from "./live-document.ts";

/*
 * A live document as markdown, the form it is kept in: every version is a
 * snapshot of it, and agents read and rewrite it. The API's copy of a live
 * document converts with these, and so does anything standing in for it.
 */

const extensions = liveDocumentExtensions({ undo: true });

/** The schema a live document has outside the editor, with the editor's nodes and marks. */
export const liveDocumentSchema = getSchema(extensions);

const markdown = new MarkdownManager({ extensions });

/** `text`, a document's markdown, as a live document. */
export const liveDocumentFromMarkdown = (text: string): Node =>
	Node.fromJSON(liveDocumentSchema, markdown.parse(text));

/** The live document as markdown. */
export const markdownOfLiveDocument = (document: Node): string =>
	markdown.serialize(document.toJSON());
