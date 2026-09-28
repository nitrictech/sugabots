import { docGroups } from "./docs/nav.ts";

/** Every page on the site, for the sitemap. The docs come from the docs nav, in reading order. */
export const sitePagePaths: readonly string[] = [
	"/",
	"/docs",
	...docGroups.flatMap((group) => group.pages.map(({ slug }) => `/docs/${slug}`)),
];
