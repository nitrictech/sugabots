import type { BotLook } from "@sugabots/avatars";
import GithubSlugger from "github-slugger";
import type { MDXContent } from "mdx/types";
import { type DocGroup, docGroups } from "@/docs/nav";

/** What each page's frontmatter must say. */
interface Frontmatter {
	title: string;
	/** One sentence: the page's lede, its card on the docs home, and its meta description. */
	description: string;
}

interface DocModule {
	default: MDXContent;
	frontmatter: Frontmatter;
}

/** A second-level heading, for the page's table of contents. */
export interface Heading {
	/** The anchor rehype-slug gives the heading. */
	id: string;
	text: string;
}

export interface DocPage extends Frontmatter {
	slug: string;
	group: Pick<DocGroup, "title" | "tone">;
	bot: BotLook;
	Content: MDXContent;
	headings: readonly Heading[];
	/** The page as Markdown, headed by its title and description, for readers who want to paste it elsewhere. */
	markdown: string;
}

const CONTENT_DIRECTORY = "./content/";

const modules = import.meta.glob<DocModule>("./content/*.mdx", { eager: true });
const sources = import.meta.glob<string>("./content/*.mdx", {
	eager: true,
	query: "?raw",
	import: "default",
});

function slugFromPath(path: string) {
	return path.slice(CONTENT_DIRECTORY.length, -".mdx".length);
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n+/;
const CODE_FENCE = /^(```|~~~)/;

/** Inline Markdown reduced to the text rehype-slug sees: no code ticks, emphasis or link targets. */
function plainText(markdown: string) {
	return markdown
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim();
}

/** The page's `##` headings, with the ids rehype-slug gives them. */
function secondLevelHeadings(markdown: string): Heading[] {
	// rehype-slug numbers repeated headings across the whole page, so every level counts.
	const slugger = new GithubSlugger();
	const headings: Heading[] = [];
	let inCodeFence = false;
	for (const line of markdown.split("\n")) {
		if (CODE_FENCE.test(line)) inCodeFence = !inCodeFence;
		const match = inCodeFence ? null : /^(#{1,6})\s+(.+)$/.exec(line);
		if (!match?.[1] || !match[2]) continue;
		const text = plainText(match[2]);
		const id = slugger.slug(text);
		if (match[1].length === 2) headings.push({ id, text });
	}
	return headings;
}

function loadPages(): DocPage[] {
	const pages = docGroups.flatMap((group) =>
		group.pages.map(({ slug, bot }) => {
			const path = `${CONTENT_DIRECTORY}${slug}.mdx`;
			const module = modules[path];
			const source = sources[path];
			if (!module || source === undefined)
				throw new Error(`docs/nav.ts lists ${slug}, but ${path} is missing`);
			const body = source.replace(FRONTMATTER, "");
			const { title, description } = module.frontmatter;
			return {
				title,
				description,
				slug,
				group: { title: group.title, tone: group.tone },
				bot,
				Content: module.default,
				headings: secondLevelHeadings(body),
				markdown: `# ${title}\n\n${description}\n\n${body}`,
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
