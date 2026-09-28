/** The headline, split where the accent colour ends. */
const headline = { accent: "Multiplayer", rest: "agents on any model" } as const;

/** What the site says about itself: the hero, the page head and the link-preview image. */
export const siteMeta = {
	url: "https://sugabots.ai",
	headline,
	title: `Sugabots | ${headline.accent} ${headline.rest}`,
	description: "An open-source harness where people and agents work together.",
	/** Written by scripts/generate-og-image.tsx. */
	ogImagePath: "/og.png",
} as const;

/** What the docs home says about the docs, in its page head and in its Markdown version. */
export const docsMeta = {
	title: "Sugabots docs",
	description: "How Sugabots works: pods, agents, tools and models, and how to run it yourself.",
} as const;

/**
 * A page's address on the live site. Pages are prerendered to `<path>.html`,
 * which Cloudflare serves without a trailing slash, so the address has none.
 */
export function pageUrl(pathname: string) {
	return `${siteMeta.url}${pathname.replace(/\/+$/, "") || "/"}`;
}

/** A file's address on the live site, such as `/llms.txt` or `/docs/quickstart.md`. */
export function fileUrl(path: string) {
	return `${siteMeta.url}${path}`;
}
