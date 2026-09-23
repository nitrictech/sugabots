import type { ThreadParticipant } from "@sugabots/contracts";
import type { Root } from "hast";
import { createElement, type ReactNode, useMemo } from "react";
import { type Components, type ExtraProps, Streamdown } from "streamdown";
import type { PluggableList, Plugin } from "unified";
import { visit } from "unist-util-visit";
import { MENTION_TAG, Mention, remarkMentions } from "./mentions.tsx";

/*
 * An agent's words as markdown. Streamdown is the AI SDK's renderer for text
 * that is still arriving: an unclosed `**` or code fence is drawn as though
 * closed rather than as raw punctuation until the rest streams in, and the
 * output is sanitised, which model text needs. Its caret sits after the last
 * word while the reply is being written.
 */

export function MessageMarkdown({
	text,
	mentionable,
	streaming,
}: {
	text: string;
	mentionable: ThreadParticipant[];
	streaming: boolean;
}) {
	const remarkPlugins = useMemo(
		(): PluggableList => [[remarkMentions, mentionable]],
		[mentionable],
	);
	const components = useMemo(() => componentsFor(mentionable), [mentionable]);
	return (
		<Streamdown
			className={`${BREAK_LONG_WORDS} text-foreground text-xl leading-relaxed`}
			remarkPlugins={remarkPlugins}
			rehypePlugins={REHYPE_PLUGINS}
			allowedTags={ALLOWED_TAGS}
			components={components}
			controls={CONTROLS}
			isAnimating={streaming}
			caret={text ? "block" : undefined}
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

const ALLOWED_TAGS = { [MENTION_TAG]: ["handle"] };

/* A copy button on code is worth its space in a bubble; table and image tooling is not. */
const CONTROLS = {
	code: { copy: true, download: false },
	table: false,
	mermaid: false,
	image: false,
};

function componentsFor(mentionable: ThreadParticipant[]): Components {
	return {
		[MENTION_TAG]: ({ handle, children }) => {
			const participant = mentionable.find((candidate) => candidate.handle === handle);
			return participant ? <Mention participant={participant} /> : (children as ReactNode);
		},
		// Streamdown's headings are sized for a page; a bubble is 480px wide.
		h1: heading("h1", "text-2xl"),
		h2: heading("h2", "text-xl"),
		h3: heading("h3", "text-lg"),
	};
}

function heading(tag: "h1" | "h2" | "h3", size: string) {
	return ({ children }: ExtraProps & { children?: unknown }) =>
		createElement(
			tag,
			{ className: `mt-4 mb-1 font-semibold text-heading ${size}` },
			children as ReactNode,
		);
}
