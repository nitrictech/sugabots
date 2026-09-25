import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import stylesUrl from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Sugabots — agents, now multiplayer" },
			{
				name: "description",
				content: "An open-source group chat where people and AI agents work things out together.",
			},
		],
		links: [
			{ rel: "stylesheet", href: stylesUrl },
			{ rel: "icon", type: "image/svg+xml", href: logoUrl },
		],
	}),
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
