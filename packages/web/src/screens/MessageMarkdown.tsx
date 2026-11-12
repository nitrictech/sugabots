import type { MessageAuthor } from "@sugabots/contracts";
import { cn } from "cn";
import type { ElementContent, Root } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Definition, Image, Link, Root as MdastRoot } from "mdast";
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
import remarkBreaks from "remark-breaks";
import remarkGfm, { type Options as GfmOptions } from "remark-gfm";
import {
	type Components,
	defaultRemarkPlugins,
	type ExtraProps,
	Streamdown,
	type StreamdownProps,
} from "streamdown";
import type { PluggableList, Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { visitParents } from "unist-util-visit-parents";
import { Button } from "@/ui/button.tsx";
import { codeHighlighter } from "./code-highlighter.ts";
import { MarkdownImageLink, MarkdownLink } from "./MarkdownLink.tsx";
import {
	MarkdownMention,
	MENTION_TAG,
	MentionableContext,
	type MentionTarget,
	remarkMentions,
} from "./mentions.tsx";

/*
 * A message's words as markdown. Streamdown is the AI SDK's renderer: it
 * forgives the unclosed `**` or code fence a model sometimes leaves behind.
 * Raw HTML in the text is drawn as the text it is. A message is only drawn
 * once it is finished, so none of Streamdown's streaming behaviour is used.
 */

export function MessageMarkdown({
	text,
	mentionable,
	writer,
}: {
	text: string;
	/** Everyone a mention in the text could name. */
	mentionable: readonly MentionTarget[];
	/** A bot, routine or artifact writes markdown on purpose; a person writes chat. See `WRITERS`. */
	writer: MarkdownWriter;
}) {
	const { className, remarkPlugins, components, completesUnclosedMarkup } = WRITERS[writer];
	return (
		<MentionableContext value={mentionable}>
			<Streamdown
				className={cn(BREAK_LONG_WORDS, "message-markdown", className)}
				remarkPlugins={remarkPlugins}
				rehypePlugins={REHYPE_PLUGINS}
				components={components}
				controls={CONTROLS}
				plugins={PLUGINS}
				// A long block folds instead (see `FoldingCodeBlock`), so the bubble never holds a scroller of its own.
				codeBlockMaxHeight={Number.POSITIVE_INFINITY}
				parseIncompleteMarkdown={completesUnclosedMarkup}
				remend={COMPLETIONS}
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
 * An image is drawn as a link to it, never loaded: a bot led by planted
 * instructions could write one whose address carries the conversation, sent
 * out as soon as anyone read the reply. Sugabots' own addresses are no
 * exception. Inside a link already, an image is only its words.
 */
const rehypeImagesAsLinks: Plugin<[], Root> = () => (tree) => {
	visitParents(tree, "element", (node, ancestors) => {
		const parent = ancestors.at(-1);
		if (node.tagName !== "img" || !parent) return;
		const src = String(node.properties.src ?? "");
		const words: ElementContent = { type: "text", value: String(node.properties.alt ?? "") || src };
		const inLink = ancestors.some(
			(ancestor) => ancestor.type === "element" && ancestor.tagName === "a",
		);
		parent.children[parent.children.indexOf(node)] = inLink
			? words
			: { type: "element", tagName: IMAGE_LINK_TAG, properties: { href: src }, children: [words] };
	});
};

/** The element `rehypeImagesAsLinks` puts in an image's place; `MarkdownImageLink` draws it. */
const IMAGE_LINK_TAG = "image-link";

/* What a link in a person's message may lead to: a web page, or an email to write. */
const PERSON_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/*
 * A person's link or image that leads anywhere else is shown as they wrote it,
 * brackets and all. A relative one leads into Sugabots, where a link opens
 * unasked, under words that can say it goes somewhere else; another scheme can
 * open an app on the reader's computer. A reference's definition is shown as
 * written too, which leaves the references it would have made links as text.
 */
const remarkOnlyWebLinks: Plugin<[], MdastRoot> = () => (tree, file) => {
	const asWritten = ({ position, url }: Definition | Link | Image) =>
		position ? String(file.value).slice(position.start.offset, position.end.offset) : url;
	visit(tree, "definition", (node, index, parent) => {
		if (!parent || index === undefined) return;
		parent.children[index] = {
			type: "paragraph",
			children: [{ type: "text", value: asWritten(node) }],
		};
	});
	visit(tree, (node, index, parent) => {
		if (node.type !== "link" && node.type !== "image") return;
		if (!parent || index === undefined) return;
		if (PERSON_LINK_SCHEMES.has(URL.parse(node.url)?.protocol ?? "")) return;
		parent.children[index] = { type: "text", value: asWritten(node) };
		return SKIP;
	});
};

/*
 * These replace Streamdown's own rehype plugins, its sanitiser among them, so
 * nothing strips the `<mention>` elements `remarkMentions` adds. Streamdown's
 * `allowedTags` only reaches the sanitiser when its own plugins are in use.
 * Without its `rehype-raw` either, HTML in a message is drawn as text, which
 * keeps anyone in a pod from putting markup in front of the others: never
 * add it. Nothing filters link addresses; React refuses `javascript:` ones.
 * `rehypeImagesAsLinks` keeps every writer's images from loading, so never
 * drop it either.
 */
const REHYPE_PLUGINS: PluggableList = [
	rehypeImagesAsLinks,
	rehypeFocusableCodeBlocks,
	rehypeSoftBreaks,
];

/*
 * Streamdown's own remark plugins, which give it tables and strikethrough and
 * which passing any replaces, with GFM's given `gfmOptions`, then mentions.
 */
function remarkPluginsWith(gfmOptions: GfmOptions): PluggableList {
	const { gfm: _replaced, ...otherDefaults } = defaultRemarkPlugins;
	return [[remarkGfm, gfmOptions], ...Object.values(otherDefaults), remarkMentions];
}

/*
 * The completions Streamdown leaves out of a bot's reply. The rest stay on,
 * among them closing the `**`, `*`, `~~`, backtick or code fence a model
 * sometimes leaves open. These four are for text still arriving and damage a
 * finished reply: `htmlTags` drops everything after an unclosed `<` as a
 * half-written tag, so "List<String for that" becomes "List"; `links` points
 * an unclosed link at nothing; `images` drops an unclosed image; and `katex`
 * adds a `$$` to close a lone one.
 */
const COMPLETIONS: StreamdownProps["remend"] = {
	htmlTags: false,
	links: false,
	images: false,
	katex: false,
};

/* A copy button on code is worth its space in a bubble. */
const CONTROLS = {
	code: { copy: true, download: false },
	mermaid: false,
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
	[IMAGE_LINK_TAG]: MarkdownImageLink,
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

type MarkdownWriter = "bot" | "person";

/** Whose markdown `author`'s text is: a person's, or else a bot's, as a routine's is. */
export function writerOf(author: MessageAuthor): MarkdownWriter {
	return author.kind === "person" ? "person" : "bot";
}

/*
 * How each writer's markdown differs. A person presses Shift+Enter to start a
 * new line and expects to see one, so their single line breaks are kept. What
 * they send is finished as written: a lone backtick or `**` stays as typed
 * rather than being closed for them, and a single `~`, as in "~5 min", is not
 * strikethrough. A bot's page colours, which reach a person's message in its
 * channel, are kept off their links and code.
 *
 * Links are `MarkdownLink`s, as Streamdown's own becomes a button when it
 * warns before leaving, losing middle-click and the hover preview.
 */
const WRITERS = {
	bot: {
		className: undefined,
		remarkPlugins: remarkPluginsWith({}),
		components: { ...COMPONENTS, a: (props) => <MarkdownLink {...props} asks="always" /> },
		completesUnclosedMarkup: true,
	},
	person: {
		className: "[--bot-mono:initial] [--bot-tint:initial]",
		remarkPlugins: [...remarkPluginsWith({ singleTilde: false }), remarkOnlyWebLinks, remarkBreaks],
		components: {
			...COMPONENTS,
			a: (props) => <MarkdownLink {...props} asks="unless-text-is-address" />,
		},
		completesUnclosedMarkup: false,
	},
} satisfies Record<
	MarkdownWriter,
	{
		className: string | undefined;
		remarkPlugins: PluggableList;
		components: Components;
		completesUnclosedMarkup: boolean;
	}
>;
