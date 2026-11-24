/**
 * A docs page's MDX as plain Markdown, for anyone reading it as text: the
 * server's bots, and the website's Markdown copies and `llms-full.txt`.
 * Free of the filesystem, so the website's browser build can use it.
 */

import { rolesMarkdown } from "./roles.ts";

/** The frontmatter block at the top of a page, with the blank lines after it. */
export const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/;
const COMPONENT_LINE = /^<([A-Z]\w*)\s*\/>$/gm;

/**
 * Interactive components whose content a reader of the text would miss, as
 * the Markdown that says the same. Any other component is left as written.
 */
const COMPONENTS_AS_MARKDOWN: Record<string, string> = { RoleMatrix: rolesMarkdown() };

/** The page's body after its frontmatter, with its interactive components written out as Markdown. */
export function pageMarkdown(source: string): string {
	return source
		.replace(FRONTMATTER, "")
		.replace(COMPONENT_LINE, (line, name: string) => COMPONENTS_AS_MARKDOWN[name] ?? line);
}

/** Inline Markdown reduced to its words, as rehype-slug sees them: no code ticks, emphasis or link targets. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim();
}
