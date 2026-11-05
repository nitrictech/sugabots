import type { ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import type { Root } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
	type CSSProperties,
	cloneElement,
	createElement,
	isValidElement,
	type ReactNode,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { type Components, defaultRemarkPlugins, type ExtraProps, Streamdown } from "streamdown";
import type { PluggableList, Plugin } from "unified";
import { visit } from "unist-util-visit";
import { Button } from "@/ui/button.tsx";
import { codeHighlighter } from "./code-highlighter.ts";
import { MarkdownLink } from "./MarkdownLink.tsx";
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
				className={`${BREAK_LONG_WORDS} message-markdown`}
				remarkPlugins={REMARK_PLUGINS}
				rehypePlugins={REHYPE_PLUGINS}
				components={COMPONENTS}
				controls={CONTROLS}
				plugins={PLUGINS}
				// A long block folds instead (see `FoldingCodeBlock`), so the bubble never holds a scroller of its own.
				codeBlockMaxHeight={Number.POSITIVE_INFINITY}
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
 * rehypeFocusableCodeBlocks makes fenced code scrollers keyboard-focusable
 * and labels them for assistive technology. Streamdown forwards these props
 * from the `code` element to its scroller. A group provides a label without
 * adding every code block in the conversation to landmark navigation.
 */
const rehypeFocusableCodeBlocks: Plugin<[], Root> = () => (tree) => {
	visit(tree, "element", (node) => {
		if (node.tagName !== "pre") return;
		for (const child of node.children) {
			if (child.type !== "element" || child.tagName !== "code") continue;
			child.properties.tabIndex = 0;
			child.properties.role = "group";
			child.properties.ariaLabel = "Code block";
		}
	});
};

/* `<wbr>` after each `/` or `.` in an inline-code or link token, so a long
 * path or URL wraps there instead of crowding the cells next to it. */
const rehypeSoftBreaks: Plugin<[], Root> = () => (tree) => {
	visit(tree, "element", (node, _index, parent) => {
		const inlineCode =
			node.tagName === "code" && !(parent?.type === "element" && parent.tagName === "pre");
		if (!inlineCode && node.tagName !== "a") return;
		const expanded: typeof node.children = [];
		for (const child of node.children) {
			if (child.type !== "text") {
				expanded.push(child);
				continue;
			}
			for (const [i, text] of child.value.split(/(?<=[/._-])/).entries()) {
				if (i > 0) expanded.push({ type: "element", tagName: "wbr", properties: {}, children: [] });
				expanded.push({ type: "text", value: text });
			}
		}
		node.children = expanded;
	});
};

/*
 * These replace Streamdown's own rehype plugins, its sanitiser among them, so
 * nothing strips the `<mention>` elements `remarkMentions` adds. Streamdown's
 * `allowedTags` only reaches the sanitiser when its own plugins are in use.
 */
const REHYPE_PLUGINS: PluggableList = [rehypeFocusableCodeBlocks, rehypeSoftBreaks];

/* Streamdown's own plugins give it tables and strikethrough; passing any replaces them. */
const REMARK_PLUGINS: PluggableList = [...Object.values(defaultRemarkPlugins), remarkMentions];

/* A copy button on code is worth its space in a bubble; image tooling is not. */
const CONTROLS = {
	code: { copy: true, download: false },
	mermaid: false,
	image: false,
};

/* Syntax highlighting for fenced code; see `code-highlighter.ts`. */
const PLUGINS = { code: codeHighlighter };

/**
 * ScrollingTable renders a table in a labelled, keyboard-focusable horizontal
 * scroller. Streamdown puts table props on the table rather than its scroller,
 * so a custom wrapper is needed to make the scroller focusable. A group keeps
 * individual tables out of landmark navigation; the table retains its native
 * semantics.
 */
function ScrollingTable({ children }: ExtraProps & { children?: ReactNode }) {
	return (
		<div className="my-4 rounded-lg border border-border p-2">
			{/* biome-ignore lint/a11y/useSemanticElements: this group labels a table scroller, not form controls, so a fieldset is inappropriate. */}
			<div
				role="group"
				aria-label="Table"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a table wider than the bubble scrolls, so the keyboard has to reach it too.
				tabIndex={0}
				className="focus-ring overflow-x-auto rounded-md border border-border bg-background"
			>
				<table className="w-full divide-y divide-border">{children}</table>
			</div>
		</div>
	);
}

/* About 400px of code, the height Streamdown would otherwise cap a block at and scroll. */
const FOLDED_LINES = 20;

/**
 * FoldingCodeBlock shows the first `FOLDED_LINES` of a longer fenced block,
 * fading out where it is cut off, with Show more over the fade for the rest
 * and Show less under the card once it is open. The copy button still copies
 * all of it.
 */
function FoldingCodeBlock({ node, children }: ExtraProps & { children?: ReactNode }) {
	const block = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	// Streamdown's own `pre` marks its code this way, which is what makes its `code` draw the card.
	const code = isValidElement<{ "data-block"?: string }>(children)
		? cloneElement(children, { "data-block": "true" })
		: children;
	const lineCount = node ? hastToString(node).trimEnd().split("\n").length : 0;
	if (lineCount <= FOLDED_LINES) return code;
	function toggle() {
		if (!open) {
			setOpen(true);
			return;
		}
		// Folding a long block could otherwise leave the reader far below it.
		flushSync(() => setOpen(false));
		block.current?.scrollIntoView({ block: "nearest" });
	}
	return (
		<div
			ref={block}
			className="relative flex flex-col"
			data-folded={open ? undefined : ""}
			style={{ "--folded-lines": FOLDED_LINES } as CSSProperties}
		>
			{code}
			<Button
				variant="secondary"
				size="sm"
				aria-expanded={open}
				onClick={toggle}
				className={cn(
					"self-center border border-border-strong shadow-popover",
					open ? "-mt-2 mb-4" : "absolute bottom-6 left-1/2 -translate-x-1/2",
				)}
			>
				{open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
				{open ? "Show less" : "Show more"}
			</Button>
		</div>
	);
}

const COMPONENTS: Components = {
	[MENTION_TAG]: MarkdownMention,
	// Streamdown's own link becomes a button when it warns before leaving, losing middle-click and the hover preview.
	a: MarkdownLink,
	pre: FoldingCodeBlock,
	// Streamdown's headings are sized for a page; a bubble is 520px wide.
	h1: heading("h1", "text-base"),
	h2: heading("h2", "text-base"),
	h3: heading("h3", "text-sm"),
	table: ScrollingTable,
};

function heading(tag: "h1" | "h2" | "h3", size: string) {
	return ({ children }: ExtraProps & { children?: unknown }) =>
		createElement(tag, { className: `mt-4 mb-1 font-semibold ${size}` }, children as ReactNode);
}
