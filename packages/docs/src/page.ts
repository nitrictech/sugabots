/**
 * A docs page read from its MDX source into the Markdown every reader but the
 * website's own pages gets: bots through `read_docs`, and agents through the
 * website's Markdown versions of its pages. Reads no files, so the server and
 * the website's build can each hand it the sources their own way.
 */

import { componentsAsMarkdown } from "./components-as-markdown.ts";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/;
const CODE_FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const SECTION_DEPTH = 2;

export interface DocHeading {
	/** 1 for `#`, 2 for `##` and so on. */
	depth: number;
	/** The heading as it reads, without Markdown: `Make a routine`. */
	text: string;
}

export interface DocSection {
	/** The heading as it reads, without Markdown: `Make a routine`. */
	heading: string;
	/** The section's Markdown, starting with its `##` line. */
	markdown: string;
}

export interface DocPage {
	slug: string;
	title: string;
	/** One sentence saying what the page covers. */
	description: string;
	/** The Markdown before the page's first `##` heading. */
	intro: string;
	/** The page's `##` sections, in order. */
	sections: readonly DocSection[];
	/** Every heading in the page's body, in order, at every depth. */
	headings: readonly DocHeading[];
	/** The whole page as Markdown, headed by its title and description. */
	markdown: string;
}

/** The page named `slug`, from its MDX source. Fails on a page without a title and description. */
export function parseDocPage(slug: string, source: string): DocPage {
	const frontmatter = FRONTMATTER.exec(source);
	if (!frontmatter?.[1]) throw new Error(`docs page ${slug} has no frontmatter`);
	const fields = new Map(
		frontmatter[1].split("\n").map((line) => {
			const at = line.indexOf(":");
			return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
		}),
	);
	const title = fields.get("title");
	const description = fields.get("description");
	if (!title || !description)
		throw new Error(`docs page ${slug} needs a title and a description in its frontmatter`);
	const body = componentsAsMarkdown(slug, source.slice(frontmatter[0].length)).trim();
	const { intro, sections, headings } = splitSections(body);
	return {
		slug,
		title,
		description,
		intro,
		sections,
		headings,
		markdown: `# ${title}\n\n${description}\n\n${body}`,
	};
}

/** The body cut at each `##` heading outside a code block, and every heading in it. */
function splitSections(body: string) {
	const introLines: string[] = [];
	const sections: Array<{ heading: string; lines: string[] }> = [];
	const headings: DocHeading[] = [];
	let inCodeFence = false;
	for (const line of body.split("\n")) {
		if (CODE_FENCE.test(line)) inCodeFence = !inCodeFence;
		const match = inCodeFence ? null : HEADING.exec(line);
		if (match?.[1] && match[2]) {
			const heading = { depth: match[1].length, text: plainText(match[2]) };
			headings.push(heading);
			if (heading.depth === SECTION_DEPTH) sections.push({ heading: heading.text, lines: [] });
		}
		(sections.at(-1)?.lines ?? introLines).push(line);
	}
	return {
		intro: introLines.join("\n").trim(),
		sections: sections.map(({ heading, lines }) => ({
			heading,
			markdown: lines.join("\n").trim(),
		})),
		headings,
	};
}

/** Inline Markdown reduced to its words, as rehype-slug sees them: no code ticks, emphasis or link targets. */
function plainText(markdown: string) {
	return markdown
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim();
}
