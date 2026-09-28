import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { startAnalytics } from "@/analytics";
import { pageUrl, siteMeta } from "@/site-meta";
import stylesUrl from "../styles.css?url";

export const Route = createRootRoute({
	head: ({ matches }) => {
		const url = pageUrl(matches.at(-1)?.pathname ?? "/");
		return {
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
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
			links: [
				{ rel: "canonical", href: url },
				{ rel: "stylesheet", href: stylesUrl },
				{ rel: "icon", type: "image/svg+xml", href: logoUrl },
			],
		};
	},
	notFoundComponent: () => (
		<main className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-16">
			<h1 className="text-4xl font-extrabold tracking-tight">Page not found</h1>
			<a href="/" className="text-muted-foreground hover:text-foreground">
				Back to Sugabots
			</a>
		</main>
	),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	useEffect(startAnalytics, []);

	return (
		<html lang="en">
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
