import { markdownPath } from "./markdown.ts";

/**
 * Docs pages that were renamed when pods became projects, by their old
 * address, with the page each became. Links to the old addresses live on
 * outside the site, so they keep working.
 */
export const RENAMED_DOCS: Readonly<Record<string, string>> = {
	"/docs/pods": "/docs/projects",
	"/docs/routines": "/docs/automations",
	"/docs/conversations": "/docs/chats",
	"/docs/connections": "/docs/connectors",
	"/docs/people-and-roles": "/docs/members-and-roles",
};

/** Where a renamed docs page, or its Markdown version, is now; `undefined` for any other path. */
export function renamedDocsPath(pathname: string): string | undefined {
	const markdown = pathname.endsWith(".md");
	const page = markdown ? pathname.slice(0, -".md".length) : pathname.replace(/\/$/, "");
	const renamed = RENAMED_DOCS[page];
	if (!renamed) return undefined;
	return markdown ? markdownPath(renamed) : renamed;
}
