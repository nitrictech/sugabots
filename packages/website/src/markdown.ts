/**
 * Each page's Markdown version, for AI agents. The Worker serves it to page
 * requests that ask for `text/markdown`.
 */

export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** Where a page's Markdown version is served: `/` at `/index.md`, `/docs/quickstart` at `/docs/quickstart.md`. */
export function markdownPath(pagePath: string) {
	const path = pagePath.replace(/\/+$/, "");
	return path === "" ? "/index.md" : `${path}.md`;
}

export function markdownResponse(body: string, status = 200) {
	return new Response(body, {
		status,
		headers: { "Content-Type": MARKDOWN_CONTENT_TYPE },
	});
}
