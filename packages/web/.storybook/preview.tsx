import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import { LivelinessContext, livelinessLevels } from "@sugabots/avatars";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { setupWorker } from "msw/browser";
import addonMsw from "msw-storybook-addon";
import { useEffect, useState } from "react";
import { configure } from "storybook/test";
import { INITIAL_VIEWPORTS } from "storybook/viewport";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import "../src/app.css";

// A busy machine can take longer than the default second to show what a play function looks
// for. Waiting longer only slows a story that would otherwise fail. This stays well under the
// stories' limit per test, in vitest.config.ts, so a real miss fails saying what it could not find.
configure({ asyncUtilTimeout: 10_000 });

/** How long the page must go unchanged before the accessibility check reads it. */
const STILL_FOR_MS = 200;
/** How long a story may keep changing after its play function ends before it fails. */
const STILLNESS_LIMIT_MS = 5_000;

/**
 * Waits until nothing in the page has changed or scrolled for
 * {@link STILL_FOR_MS}. A play function ends once it has seen what it tests,
 * which can be before the page finishes changing, such as a chat still
 * scrolling to its latest or a menu still closing; on a busy machine that
 * window is wide enough for the check to land in. Rejects if the page never
 * settles, since the check would then read it mid-change.
 */
function waitForStillness(): Promise<void> {
	return new Promise((resolve, reject) => {
		let stillTimer: ReturnType<typeof setTimeout> | undefined;
		const observer = new MutationObserver(restart);
		const limitTimer = setTimeout(
			() =>
				stop(() =>
					reject(
						new Error(
							`The story was still changing ${STILLNESS_LIMIT_MS}ms after its play function ended, so the accessibility check would read it mid-change.`,
						),
					),
				),
			STILLNESS_LIMIT_MS,
		);
		function restart() {
			clearTimeout(stillTimer);
			stillTimer = setTimeout(() => stop(resolve), STILL_FOR_MS);
		}
		function stop(settle: () => void) {
			observer.disconnect();
			document.removeEventListener("scroll", restart, { capture: true });
			clearTimeout(stillTimer);
			clearTimeout(limitTimer);
			settle();
		}
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		document.addEventListener("scroll", restart, { capture: true, passive: true });
		restart();
	});
}

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
		liveliness: {
			description: "How much bots' faces move",
			toolbar: {
				icon: "lightning",
				items: [...livelinessLevels],
				dynamicTitle: true,
			},
		},
	},
	// Faces stay still unless a story or the toolbar asks, so runs are repeatable.
	initialGlobals: { theme: "dark", liveliness: "off" },
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
		a11y: {
			test: "error",
			config: {
				rules: [
					{
						// Frimousse, the emoji picker, numbers its grid's rows and columns from 0, where ARIA
						// starts at 1, and finds a row by that number to scroll it into view, so it cannot
						// be renumbered here. Any story can open the picker, from a message or the composer.
						// The rule still checks everything else: disabling it would switch it off everywhere.
						// A story that sets its own rules replaces this list, so it must repeat this one.
						id: "aria-valid-attr-value",
						selector: "*:not([frimousse-row]):not([frimousse-emoji])",
					},
				],
			},
		},
		options: { storySort: { order: ["Controls", "Patterns", "Product", "Views"] } },
	},
	// Storybook runs `afterEach` hooks last registered first, so the preview's own runs before the
	// accessibility addon's check. It runs when viewing a story too, so the panel shows what tests
	// check, but not on a docs page, where the addon checks nothing and every story shares the page.
	afterEach: ({ viewMode }) => (viewMode === "story" ? waitForStillness() : undefined),
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
					<LivelinessContext value={context.globals.liveliness}>
						<Story />
					</LivelinessContext>
				</TooltipProvider>
			);
		},
	],
});
