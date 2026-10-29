/**
 * Serves the prerendered site, and each page's Markdown version to requests
 * that prefer `text/markdown`, such as AI agents', and handles the site's
 * redirects. Built by Wrangler, not Vite.
 */

import { MARKDOWN_CONTENT_TYPE, markdownPath, markdownResponse } from "./markdown.ts";
import { NOT_FOUND_PAGE_PATH } from "./not-found.ts";
import { DISCORD_PATH } from "./site-links.ts";
import { fileUrl } from "./site-meta.ts";

/**
 * The current Discord invite. Links go to `DISCORD_PATH` instead, which
 * redirects here, so replacing the invite is a change to this line alone.
 */
const DISCORD_INVITE = "https://discord.gg/YPuHCVAsx";

export interface Env {
	/** The built site in `dist/client`. */
	ASSETS: { fetch(request: Request): Promise<Response> };
}

const NOT_FOUND_MARKDOWN = `# Page not found

There's no page at this address on the Sugabots site. See [llms.txt](${fileUrl("/llms.txt")}) for what's here, the [docs](${fileUrl("/docs.md")}), or the [sitemap](${fileUrl("/sitemap.xml")}).
`;

export default {
	async fetch(request: Request, env: Env) {
		const { pathname } = new URL(request.url);
		if (pathname === DISCORD_PATH || pathname === `${DISCORD_PATH}/`) {
			// Temporary, so browsers don't keep sending people to a replaced invite.
			return Response.redirect(DISCORD_INVITE, 302);
		}
		// Files such as images, scripts and `llms.txt` are served as they are.
		if (!isPagePath(pathname)) return env.ASSETS.fetch(request);
		if (pathname === NOT_FOUND_PAGE_PATH) return notFoundPage(request, env);
		if (!prefersMarkdown(request.headers.get("Accept") ?? "")) {
			return varyOnAccept(await env.ASSETS.fetch(request));
		}

		const markdownUrl = new URL(markdownPath(pathname), request.url);
		const markdown = await env.ASSETS.fetch(new Request(markdownUrl, request));
		if (markdown.status !== 404) {
			const response = varyOnAccept(markdown);
			if (markdown.ok || markdown.status === 304) {
				response.headers.set("Content-Type", MARKDOWN_CONTENT_TYPE);
			}
			return response;
		}

		// A page without a Markdown version is served as HTML; a missing one gets a Markdown 404.
		const page = await env.ASSETS.fetch(request);
		if (page.status === 404) return varyOnAccept(markdownResponse(NOT_FOUND_MARKDOWN, 404));
		return varyOnAccept(page);
	},
};

/**
 * The address `404.html` is served at, which has no page of its own: a 404, with
 * the not-found page for a browser and the Markdown 404 to a request that asks for Markdown.
 */
async function notFoundPage(request: Request, env: Env) {
	if (prefersMarkdown(request.headers.get("Accept") ?? "")) {
		return varyOnAccept(markdownResponse(NOT_FOUND_MARKDOWN, 404));
	}
	// Without the request's conditional headers, so the page comes back whole rather than as a 304.
	const page = await env.ASSETS.fetch(new Request(request.url, { method: request.method }));
	return varyOnAccept(new Response(page.body, { status: 404, headers: page.headers }));
}

/** Pages have no file extension in their last segment: `/docs/quickstart`, not `/og.png`. */
function isPagePath(pathname: string) {
	const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
	return !lastSegment.includes(".");
}

/**
 * Whether the `Accept` header names `text/markdown`, and rates it at least as
 * highly as HTML. HTML's rating comes from its most specific range, wildcards
 * included; Markdown must be named, so a request that accepts anything still gets HTML.
 */
function prefersMarkdown(accept: string) {
	const ranges = mediaRangeQualities(accept);
	const markdown = ranges.get("text/markdown") ?? 0;
	const html = ranges.get("text/html") ?? ranges.get("text/*") ?? ranges.get("*/*") ?? 0;
	return markdown > 0 && markdown >= html;
}

const HTTP_QUALITY_VALUE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

/** mediaRangeQualities parses Accept weights, defaulting to 1 when omitted and 0 when invalid. */
function mediaRangeQualities(accept: string) {
	return new Map(
		accept.split(",").map((range) => {
			const [mediaRange = "", ...parameters] = range.split(";").map((part) => part.trim());
			const qualityParameter = parameters.find((parameter) =>
				parameter.toLowerCase().startsWith("q="),
			);
			if (qualityParameter === undefined) return [mediaRange.toLowerCase(), 1];
			const qualityValue = qualityParameter.slice("q=".length);
			const quality = HTTP_QUALITY_VALUE.test(qualityValue) ? Number(qualityValue) : 0;
			return [mediaRange.toLowerCase(), quality];
		}),
	);
}

/** Pages differ by `Accept`, so caches must keep the HTML and Markdown responses apart. */
function varyOnAccept(response: Response) {
	const varied = new Response(response.body, response);
	varied.headers.append("Vary", "Accept");
	return varied;
}
