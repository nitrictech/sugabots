import type { ThreadParticipant } from "@sugabots/contracts";
import type { Root } from "hast";
import { createElement, type ReactNode } from "react";
import { type Components, defaultRemarkPlugins, type ExtraProps, Streamdown } from "streamdown";
import type { PluggableList, Plugin } from "unified";
import { visit } from "unist-util-visit";
import { MarkdownMention, MENTION_TAG, MentionableContext, remarkMentions } from "./mentions.tsx";

/*
 * An agent's words as markdown. Streamdown is the AI SDK's renderer: it
 * forgives the unclosed `**` or code fence a model sometimes leaves behind, and
 * its output is sanitised, which model text needs. A reply is only drawn once
 * it is finished, so none of its streaming behaviour is used.
 */

export function MessageMarkdown({
	text,
	mentionable,
}: {
	text: string;
	/** Everyone a mention in the text could name. */
	mentionable: ThreadParticipant[];
}) {
	return (
		<MentionableContext value={mentionable}>
			<Streamdown
				className={`${BREAK_LONG_WORDS} message-markdown text-bot-text text-lg`}
				remarkPlugins={REMARK_PLUGINS}
				rehypePlugins={REHYPE_PLUGINS}
				components={COMPONENTS}
				controls={CONTROLS}
				isAnimating={false}
			>
				{text}
			</Streamdown>
		</MentionableContext>
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

/*
 * These replace Streamdown's own rehype plugins, its sanitiser among them, so
 * nothing strips the `<mention>` elements `remarkMentions` adds. Streamdown's
 * `allowedTags` only reaches the sanitiser when its own plugins are in use.
 */
const REHYPE_PLUGINS: PluggableList = [rehypeFocusableCodeBlocks];

/* Streamdown's own plugins give it tables and strikethrough; passing any replaces them. */
const REMARK_PLUGINS: PluggableList = [...Object.values(defaultRemarkPlugins), remarkMentions];

/* A copy button on code is worth its space in a bubble; table and image tooling is not. */
const CONTROLS = {
	code: { copy: true, download: false },
	table: false,
	mermaid: false,
	image: false,
};

const COMPONENTS: Components = {
	[MENTION_TAG]: MarkdownMention,
	// Streamdown's headings are sized for a page; a bubble is 520px wide.
	h1: heading("h1", "text-2xl"),
	h2: heading("h2", "text-xl"),
	h3: heading("h3", "text-lg"),
};

function heading(tag: "h1" | "h2" | "h3", size: string) {
	return ({ children }: ExtraProps & { children?: unknown }) =>
		createElement(tag, { className: `mt-4 mb-1 font-semibold ${size}` }, children as ReactNode);
}
