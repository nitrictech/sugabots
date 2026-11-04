import { render } from "@testing-library/react";
import { createElement } from "react";
import { MessageMarkdown } from "./screens/MessageMarkdown.tsx";

/*
 * What `MessageMarkdown` draws for some markdown, as an outline of its blocks
 * and their words, for the shared cases in `packages/contracts/cases` that the
 * phone apps' own markdown is checked against. Words are as they read, without
 * their marks: what is bold or a link is left to each platform's renderer.
 * Outside code a browser draws each run of whitespace as one space, so a line
 * break in a paragraph is one only where markdown breaks the line.
 */

/** One block of a drawn message. */
export type MarkdownBlock =
	| { type: "paragraph"; text: string }
	| { type: "heading"; level: number; text: string }
	| {
			type: "list";
			ordered: boolean;
			start?: number;
			/** Each item's words, whether it is a task that is done when it is one, and the blocks under it. */
			items: { text: string; checked?: boolean; blocks: MarkdownBlock[] }[];
	  }
	| { type: "quote"; blocks: MarkdownBlock[] }
	| { type: "code"; language: string | null; code: string }
	| { type: "table"; header: string[]; rows: string[][] }
	| { type: "rule" };

/** The blocks `MessageMarkdown` draws for `markdown`. */
export function markdownOutline(markdown: string): MarkdownBlock[] {
	const { container, unmount } = render(
		createElement(MessageMarkdown, { text: markdown, mentionable: [] }),
	);
	const root = container.firstElementChild;
	const outline = root ? blocksIn(root) : [];
	unmount();
	return outline;
}

const HEADING = /^H([1-6])$/;

function blocksIn(parent: Element): MarkdownBlock[] {
	return [...parent.children].flatMap((element) => {
		const block = blockOf(element);
		return block ? [block] : [];
	});
}

function blockOf(element: Element): MarkdownBlock | undefined {
	const heading = HEADING.exec(element.tagName);
	if (heading) return { type: "heading", level: Number(heading[1]), text: wordsOf(element) };
	switch (element.tagName) {
		case "P":
			return { type: "paragraph", text: wordsOf(element) };
		case "UL":
		case "OL":
			return listOf(element);
		case "BLOCKQUOTE":
			return { type: "quote", blocks: blocksIn(element) };
		case "HR":
			return { type: "rule" };
	}
	if (element.getAttribute("data-streamdown") === "code-block") return codeOf(element);
	const table = element.querySelector("table");
	if (table) return tableOf(table);
	return undefined;
}

function listOf(list: Element): MarkdownBlock {
	const ordered = list.tagName === "OL";
	const items = [...list.children].map((item) => {
		// A tight item's words are its own; a loose one's are in its first paragraph.
		const blocks = [...item.children].filter((child) => !isInline(child));
		const first = blocks[0]?.tagName === "P" && !hasInlineText(item) ? blocks.shift() : undefined;
		const text = first ? wordsOf(first) : inlineWordsOf(item);
		const task = item.querySelector(
			":scope > input[type=checkbox], :scope > p > input[type=checkbox]",
		);
		const blocksInItem = blocks.flatMap((child) => blockOf(child) ?? []);
		return task instanceof HTMLInputElement
			? { text, checked: task.checked, blocks: blocksInItem }
			: { text, blocks: blocksInItem };
	});
	return ordered
		? { type: "list", ordered, start: Number(list.getAttribute("start") ?? 1), items }
		: { type: "list", ordered, items };
}

function codeOf(block: Element): MarkdownBlock {
	// Each line is drawn in a span of its own, an empty one holding a line break to keep its height.
	const lines = [...block.querySelectorAll("pre code > span")].map((line) =>
		line.textContent === "\n" ? "" : (line.textContent ?? ""),
	);
	return {
		type: "code",
		language: block.getAttribute("data-language") || null,
		code: lines.join("\n"),
	};
}

function tableOf(table: Element): MarkdownBlock {
	const cells = (row: Element) => [...row.children].map(wordsOf);
	const header = table.querySelector("thead tr");
	return {
		type: "table",
		header: header ? cells(header) : [],
		rows: [...table.querySelectorAll("tbody tr")].map(cells),
	};
}

const BLOCK_TAGS = new Set([
	"P",
	"UL",
	"OL",
	"BLOCKQUOTE",
	"HR",
	"DIV",
	"PRE",
	"TABLE",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
]);

function isInline(element: Element): boolean {
	return !BLOCK_TAGS.has(element.tagName);
}

function hasInlineText(item: Element): boolean {
	return inlineWordsOf(item) !== "";
}

/** The words of an item's own inline content, leaving out the blocks in it. */
function inlineWordsOf(item: Element): string {
	return asRead(
		[...item.childNodes]
			.filter((node) => !(node instanceof Element) || isInline(node))
			.map(rawWordsOf)
			.join(""),
	);
}

/** An element's words as they read on the page. */
function wordsOf(element: Element): string {
	return asRead(rawWordsOf(element));
}

/** Stands for a drawn line break until whitespace is collapsed; not whitespace itself, so it survives that. */
const LINE_BREAK = "\u0000";

/** A node's text, a line break where it breaks a line, and no task's checkbox. */
function rawWordsOf(node: Node): string {
	if (!(node instanceof Element)) return node.textContent ?? "";
	if (node.tagName === "BR") return LINE_BREAK;
	if (node.tagName === "INPUT") return "";
	return [...node.childNodes].map(rawWordsOf).join("");
}

/** Text as a browser draws it outside code: each run of whitespace one space, a line break only where it breaks a line. */
function asRead(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replaceAll(` ${LINE_BREAK}`, LINE_BREAK)
		.replaceAll(`${LINE_BREAK} `, LINE_BREAK)
		.replaceAll(LINE_BREAK, "\n")
		.trim();
}
