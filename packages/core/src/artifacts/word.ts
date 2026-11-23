import htmlToDocx from "@turbodocx/html-to-docx";
import { Effect } from "effect";
import { Marked } from "marked";

/** The media type of a .docx file. */
export const WORD_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A `document` artifact's markdown as a Word file titled `title`: headings,
 * lists, quotes, links, code and tables as Word's own, in Word's default
 * styles. Images and raw HTML come out as their text, but for underline.
 */
export const wordFileOf = (title: string, markdown: string): Effect.Effect<Uint8Array> =>
	Effect.promise(async () => {
		const file = await htmlToDocx(await markdownAsHtml.parse(markdown), null, { title });
		return file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(file);
	});

/*
 * The converter fetches whatever an `<img>` points at, from this process. A
 * document's markdown is written by the pod's bots and people, so an image or
 * raw HTML in it must not become a request the API makes.
 */
const markdownAsHtml = new Marked({
	renderer: {
		image: ({ text }) => escapeHtml(text),
		// Underline is the one mark markdown has no sign for, so the editor writes it as this tag.
		html: ({ text }) => (/^<\/?u>$/.test(text.trim()) ? text : escapeHtml(text)),
	},
});

const escapeHtml = (text: string) =>
	text.replace(/[&<>"]/g, (character) => HTML_ENTITIES[character] ?? character);

const HTML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};
