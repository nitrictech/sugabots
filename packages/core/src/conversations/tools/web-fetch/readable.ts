import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * A web page as something a model can read: its title and its content as
 * Markdown.
 *
 * Two kinds of page. An article (a post, a docs page, a news story) is best
 * read the way Readability reads it: the prose, with the navigation, footers
 * and asides around it left out. A listing (a repository index, a directory,
 * a search results page) is not an article, and Readability reading it as
 * one throws away exactly the link-heavy headings that carry its content. So
 * Readability is used only when it says the page is probably an article;
 * otherwise the whole page is kept, less the furniture named below.
 */
export interface ReadablePage {
	title: string | null;
	markdown: string;
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "template"]);
// An anchor whose only content was an icon we removed would come out as `[](url)`.
turndown.addRule("emptyLink", {
	// Turndown's own DOM answers `undefined`, not `null`, for a missing element.
	filter: (node) =>
		node.nodeName === "A" && !node.textContent?.trim() && !node.querySelector("img"),
	replacement: () => "",
});

/** What a whole page loses when it is kept whole: the parts that are the site, not the page. */
const FURNITURE =
	"script, style, noscript, template, iframe, svg, canvas, nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]";

type ParsedDocument = ReturnType<typeof parseHTML>["document"];

export function readablePage(html: string, url: string): ReadablePage {
	const { document } = parseHTML(html);
	absolutiseLinks(document, url);
	// linkedom's document is not lib.dom's `Document`, but it is what Readability reads.
	const readable = document as unknown as ConstructorParameters<typeof Readability>[0];
	const article = isProbablyReaderable(readable) ? new Readability(readable).parse() : null;
	const title = firstLine(article?.title ?? document.title) || null;
	const content = article?.content ?? wholePage(document);
	const markdown = turndown.turndown(content).trim();
	return { title, markdown: tidy(markdown) };
}

function wholePage(document: ParsedDocument): string {
	for (const furniture of document.querySelectorAll(FURNITURE)) {
		furniture.remove();
	}
	return document.body?.innerHTML ?? "";
}

/**
 * Links and images as full addresses, so a model can follow one. Readability
 * does this for the article it keeps; a page kept whole needs it done here.
 */
function absolutiseLinks(document: ParsedDocument, url: string) {
	for (const [selector, attribute] of [
		["a[href]", "href"],
		["img[src]", "src"],
	] as const) {
		for (const element of document.querySelectorAll(selector)) {
			const value = element.getAttribute(attribute);
			if (!value) continue;
			try {
				element.setAttribute(attribute, new URL(value, url).href);
			} catch {
				// A link that is not a URL stays as written.
			}
		}
	}
}

function firstLine(text: string | null | undefined): string {
	return (text ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/**
 * Collapses the blank and whitespace-only lines Turndown leaves behind removed
 * elements, and the padding it puts after a list marker.
 */
function tidy(markdown: string): string {
	return markdown
		.replace(/^[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^(\s*)-\s{2,}/gm, "$1- ");
}
