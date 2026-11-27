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

/** Where a renamed docs page is now; `undefined` for any other path. */
export function renamedDocsPath(pathname: string): string | undefined {
	return RENAMED_DOCS[pathname.replace(/\/$/, "")];
}

/**
 * The site's `_redirects` file, which sends each renamed page's Markdown
 * version to its new page's for good. A path with a dot is served straight
 * from the files, never reaching the Worker, so Cloudflare's file server
 * redirects these itself.
 */
export function redirectsFile(): string {
	return Object.entries(RENAMED_DOCS)
		.map(([before, now]) => `${markdownPath(before)} ${markdownPath(now)} 301\n`)
		.join("");
}
