/**
 * The docs pages as text, for the server to hand to its bots. The website
 * compiles the same files itself, from `content/`, and sets their reading
 * order and look in its own `docs/nav.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rolesMarkdown } from "./roles.ts";

/** One MDX file per page, named by its slug. */
const CONTENT_DIRECTORY = join(import.meta.dirname, "../content");

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/;
const CODE_FENCE = /^(```|~~~)/;
const SECTION_HEADING = /^##\s+(.+)$/;
const COMPONENT_LINE = /^<([A-Z]\w*)\s*\/>$/gm;

/**
 * Interactive components whose content a reader of the text would miss, as
 * the Markdown that says the same. Any other component is left as written.
 */
const COMPONENTS_AS_MARKDOWN: Record<string, string> = { RoleMatrix: rolesMarkdown() };

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
}

/** Every docs page, by slug. */
export const docPages: readonly DocPage[] = readdirSync(CONTENT_DIRECTORY)
	.filter((name) => name.endsWith(".mdx"))
	.sort()
	.map((name) =>
		parsePage(name.slice(0, -".mdx".length), readFileSync(join(CONTENT_DIRECTORY, name), "utf8")),
	);

function parsePage(slug: string, source: string): DocPage {
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
	const body = source
		.slice(frontmatter[0].length)
		.replace(COMPONENT_LINE, (line, name: string) => COMPONENTS_AS_MARKDOWN[name] ?? line);
	const { intro, sections } = splitSections(body);
	return { slug, title, description, intro, sections };
}

/** The body cut at each `##` heading outside a code block. */
function splitSections(body: string): { intro: string; sections: DocSection[] } {
	const introLines: string[] = [];
	const sections: Array<{ heading: string; lines: string[] }> = [];
	let inCodeFence = false;
	for (const line of body.split("\n")) {
		if (CODE_FENCE.test(line)) inCodeFence = !inCodeFence;
		const heading = inCodeFence ? undefined : SECTION_HEADING.exec(line)?.[1];
		if (heading) sections.push({ heading: plainText(heading), lines: [] });
		(sections.at(-1)?.lines ?? introLines).push(line);
	}
	return {
		intro: introLines.join("\n").trim(),
		sections: sections.map(({ heading, lines }) => ({
			heading,
			markdown: lines.join("\n").trim(),
		})),
	};
}

/** Inline Markdown reduced to its words: no code ticks, emphasis or link targets. */
function plainText(markdown: string) {
	return markdown
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim();
}
