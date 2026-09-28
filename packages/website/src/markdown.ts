/** Each page's Markdown version, for AI agents. */

/** Where a page's Markdown version is served: `/` at `/index.md`, `/docs/quickstart` at `/docs/quickstart.md`. */
export function markdownPath(pagePath: string) {
	const path = pagePath.replace(/\/+$/, "");
	return path === "" ? "/index.md" : `${path}.md`;
}

export function markdownResponse(markdown: string) {
	return new Response(markdown, {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
}
