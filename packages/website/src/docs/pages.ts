import type { BotLook } from "@sugabots/avatars";
import { type DocHeading, parseDocPage } from "@sugabots/docs/page";
import GithubSlugger from "github-slugger";
import type { MDXContent } from "mdx/types";
import { type DocGroup, docGroups } from "@/docs/nav";

interface DocModule {
	default: MDXContent;
}

/** A second-level heading, for the page's table of contents. */
export interface Heading {
	/** The anchor rehype-slug gives the heading. */
	id: string;
	text: string;
}

export interface DocPage {
	slug: string;
	title: string;
	/** One sentence: the page's lede, its card on the docs home, and its meta description. */
	description: string;
	group: Pick<DocGroup, "title" | "tone">;
	bot: BotLook;
	Content: MDXContent;
	headings: readonly Heading[];
	/** The page as Markdown, headed by its title and description, for agents and for readers who want to paste it elsewhere. */
	markdown: string;
}

/** The pages live in `packages/docs`, which the server reads them from too. */
const CONTENT_DIRECTORY = "../../../docs/content/";

const modules = import.meta.glob<DocModule>("../../../docs/content/*.mdx", { eager: true });
const sources = import.meta.glob<string>("../../../docs/content/*.mdx", {
	eager: true,
	query: "?raw",
	import: "default",
});

function slugFromPath(path: string) {
	return path.slice(CONTENT_DIRECTORY.length, -".mdx".length);
}

/** The page's `##` headings, with the ids rehype-slug gives them. */
function tableOfContents(headings: readonly DocHeading[]): Heading[] {
	// rehype-slug numbers repeated headings across the whole page, so every level counts.
	const slugger = new GithubSlugger();
	return headings
		.map(({ depth, text }) => ({ depth, id: slugger.slug(text), text }))
		.filter(({ depth }) => depth === 2)
		.map(({ id, text }) => ({ id, text }));
}

function loadPages(): DocPage[] {
	const pages = docGroups.flatMap((group) =>
		group.pages.map(({ slug, bot }) => {
			const path = `${CONTENT_DIRECTORY}${slug}.mdx`;
			const module = modules[path];
			const source = sources[path];
			if (!module || source === undefined)
				throw new Error(`docs/nav.ts lists ${slug}, but ${path} is missing`);
			const { title, description, headings, markdown } = parseDocPage(slug, source);
			return {
				title,
				description,
				slug,
				group: { title: group.title, tone: group.tone },
				bot,
				Content: module.default,
				headings: tableOfContents(headings),
				markdown,
			};
		}),
	);
	const listed = new Set(pages.map((page) => page.slug));
	const unlisted = Object.keys(modules)
		.map(slugFromPath)
		.filter((slug) => !listed.has(slug));
	if (unlisted.length > 0)
		throw new Error(`Add these docs pages to docs/nav.ts: ${unlisted.join(", ")}`);
	return pages;
}

/** Every docs page, in reading order. */
export const docPages: readonly DocPage[] = loadPages();

export function findDocPage(slug: string) {
	return docPages.find((page) => page.slug === slug);
}

/** The pages either side of this one in reading order, for the links at its foot. */
export function neighbours(page: DocPage) {
	const index = docPages.indexOf(page);
	return { previous: docPages[index - 1], next: docPages[index + 1] };
}
