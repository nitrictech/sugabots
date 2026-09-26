import type { Root } from "hast";
import { createElement, type ReactNode } from "react";
import { type Components, type ExtraProps, Streamdown } from "streamdown";
import type { PluggableList, Plugin } from "unified";
import { visit } from "unist-util-visit";

/*
 * An agent's words as markdown. Streamdown is the AI SDK's renderer: it
 * forgives the unclosed `**` or code fence a model sometimes leaves behind, and
 * its output is sanitised, which model text needs. A reply is only drawn once
 * it is finished, so none of its streaming behaviour is used.
 */

export function MessageMarkdown({ text }: { text: string }) {
	return (
		<Streamdown
			className={`${BREAK_LONG_WORDS} message-markdown text-bot-text text-lg`}
			rehypePlugins={REHYPE_PLUGINS}
			components={COMPONENTS}
			controls={CONTROLS}
			isAnimating={false}
		>
			{text}
		</Streamdown>
	);
}

/*
 * Prose must not run out past the bubble's edge, and a URL or a code path is
 * one unbreakable word, so it needs permission to break mid-word. Fenced code
 * keeps its own lines intact and scrolls sideways instead; see
 * `rehypeFocusableCodeBlocks`.
 */
const BREAK_LONG_WORDS = "break-words";

/**
 * Puts a fenced block's lines within reach of a keyboard. Streamdown draws a
 * block wider than the bubble in a sideways scroller, which a mouse can drag
 * and nothing else can, so the tail of every long line is out of reach for
 * keyboard and screen reader users. Marking the block as a tab stop is what
 * makes the scroller operable; Streamdown forwards props from the `code`
 * element to the scroller itself, so this sets them there.
 */
const rehypeFocusableCodeBlocks: Plugin<[], Root> = () => (tree) => {
	visit(tree, "element", (node) => {
		if (node.tagName !== "pre") return;
		for (const child of node.children) {
			if (child.type !== "element" || child.tagName !== "code") continue;
			child.properties.tabIndex = 0;
			child.properties.role = "region";
			child.properties.ariaLabel = "Code block";
		}
	});
};

const REHYPE_PLUGINS: PluggableList = [rehypeFocusableCodeBlocks];

/* A copy button on code is worth its space in a bubble; table and image tooling is not. */
const CONTROLS = {
	code: { copy: true, download: false },
	table: false,
	mermaid: false,
	image: false,
};

const COMPONENTS: Components = {
	// Streamdown's headings are sized for a page; a bubble is 520px wide.
	h1: heading("h1", "text-2xl"),
	h2: heading("h2", "text-xl"),
	h3: heading("h3", "text-lg"),
};

function heading(tag: "h1" | "h2" | "h3", size: string) {
	return ({ children }: ExtraProps & { children?: unknown }) =>
		createElement(tag, { className: `mt-4 mb-1 font-semibold ${size}` }, children as ReactNode);
}
