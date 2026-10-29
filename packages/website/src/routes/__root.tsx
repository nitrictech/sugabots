import rubikUrl from "@fontsource-variable/rubik/files/rubik-latin-wght-normal.woff2?url";
import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import { startAnalytics } from "@/analytics";
import { NotFoundPage } from "@/components/not-found-page";
import { pageUrl, siteMeta } from "@/site-meta";
import stylesUrl from "../styles.css?url";

const documentMeta = [
	{ charSet: "utf-8" },
	{ name: "viewport", content: "width=device-width, initial-scale=1" },
];

const assetLinks: ComponentProps<"link">[] = [
	{ rel: "stylesheet", href: stylesUrl },
	// Fetched with the stylesheet rather than after it, so headings don't re-wrap when it arrives.
	{
		rel: "preload",
		href: rubikUrl,
		as: "font",
		type: "font/woff2",
		crossOrigin: "anonymous",
	},
	{ rel: "icon", type: "image/svg+xml", href: logoUrl },
];

export const Route = createRootRoute({
	head: ({ match, matches }) => {
		// Set when the root shows the not-found page in place of its child routes, both for an address
		// no route matches and for a docs address with no page. TanStack has no public flag for this,
		// and the match's `status` stays "success".
		if (match._notFound) {
			return {
				meta: [
					...documentMeta,
					{ title: "Page not found | Sugabots" },
					{ name: "robots", content: "noindex" },
				],
				links: assetLinks,
			};
		}
		const url = pageUrl(matches.at(-1)?.pathname ?? "/");
		return {
			meta: [
				...documentMeta,
				{ title: siteMeta.title },
				{ name: "description", content: siteMeta.description },
				{ property: "og:type", content: "website" },
				{ property: "og:url", content: url },
				{ property: "og:title", content: siteMeta.title },
				{ property: "og:description", content: siteMeta.description },
				{ property: "og:image", content: `${siteMeta.url}${siteMeta.ogImagePath}` },
				{ property: "og:image:width", content: "1200" },
				{ property: "og:image:height", content: "630" },
				{ name: "twitter:card", content: "summary_large_image" },
			],
			links: [{ rel: "canonical", href: url }, ...assetLinks],
		};
	},
	notFoundComponent: NotFoundPage,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	useEffect(startAnalytics, []);

	return (
		// The landing page's head script marks the visitor's system on it before React loads.
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				{/* Honour the visitor's reduced-motion setting: fades stay, movement goes. */}
				<MotionConfig reducedMotion="user">{children}</MotionConfig>
				<Scripts />
			</body>
		</html>
	);
}
