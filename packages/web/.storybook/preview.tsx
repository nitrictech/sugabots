import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { setupWorker } from "msw/browser";
import addonMsw from "msw-storybook-addon";
import { useEffect, useState } from "react";
import { INITIAL_VIEWPORTS } from "storybook/viewport";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import "../src/app.css";

export default definePreview({
	addons: [
		addonDocs(),
		addonA11y(),
		addonMsw(async () => {
			const worker = setupWorker();
			await worker.start({
				quiet: true,
				onUnhandledRequest(request, print) {
					if (new URL(request.url).origin === "https://api.storybook.test") print.error();
				},
			});
			return worker;
		}),
	],
	tags: ["autodocs"],
	globalTypes: {
		theme: {
			description: "Application colour scheme",
			toolbar: {
				icon: "circlehollow",
				items: ["dark", "light", "system"],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: { theme: "dark" },
	parameters: {
		layout: "padded",
		backgrounds: { disable: true },
		viewport: {
			options: {
				...INITIAL_VIEWPORTS,
				// The devices above stop short of the app's widest layout, which starts at 1280px.
				desktop: {
					name: "Desktop",
					styles: { width: "1440px", height: "900px" },
					type: "desktop",
				},
			},
		},
		a11y: { test: "error" },
		options: { storySort: { order: ["Controls", "Patterns", "Product", "Views"] } },
	},
	decorators: [
		// A router for every story, so views that read the address or render links render as in the app.
		function Router(Story) {
			const [router] = useState(() =>
				createRouter({
					routeTree: createRootRoute({ component: () => <Story /> }),
					history: createMemoryHistory({ initialEntries: ["/"] }),
				}),
			);
			return <RouterProvider router={router} />;
		},
		function AppTheme(Story, context) {
			useEffect(() => {
				if (context.globals.theme === "dark") {
					delete document.documentElement.dataset.theme;
				} else {
					document.documentElement.dataset.theme = context.globals.theme;
				}
			}, [context.globals.theme]);
			return (
				<TooltipProvider>
					<Story />
				</TooltipProvider>
			);
		},
	],
});
