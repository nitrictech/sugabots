import { docGroups } from "./docs/nav.ts";

/**
 * Every page on the site, for the sitemap and for the build to write each
 * page's Markdown version. Built from the docs nav, which imports no MDX, so
 * `vite.config.ts` can import it too.
 */
export const sitePagePaths: readonly string[] = [
	"/",
	"/docs",
	...docGroups.flatMap((group) => group.pages.map(({ slug }) => `/docs/${slug}`)),
];
