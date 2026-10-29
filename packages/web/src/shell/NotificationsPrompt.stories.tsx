import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { NotificationsPrompt } from "./NotificationsPrompt.tsx";

/**
 * The bar across the top of the app that asks to turn notifications on
 * before the browser does, since a browser only asks after a click. It shows
 * only while this browser could be notified and is not, so in a browser that
 * can't, or has blocked them, there is nothing to see. These stories set the
 * browser to not having been asked yet, whatever it really says.
 */
const meta = preview.meta({
	title: "Product/NotificationsPrompt",
	component: NotificationsPrompt,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<QueryClientProvider client={new QueryClient()}>
				<Story />
			</QueryClientProvider>
		),
	],
	beforeEach() {
		localStorage.removeItem("sugabots-notifications-prompt-dismissed");
		localStorage.removeItem("sugabots-notifications-on");
		const asked = Object.getOwnPropertyDescriptor(Notification, "permission");
		Object.defineProperty(Notification, "permission", { value: "default", configurable: true });
		return () => {
			if (asked) Object.defineProperty(Notification, "permission", asked);
			else Reflect.deleteProperty(Notification, "permission");
		};
	},
});

export const Asking = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Turn on" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Not now" })).toBeInTheDocument();
	},
});

/** Not now puts the bar away in this browser for good; Settings still turns them on. */
export const PuttingItAway = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Not now" }));
		await expect(canvas.queryByRole("region", { name: "Turn on notifications" })).toBeNull();
	},
});
