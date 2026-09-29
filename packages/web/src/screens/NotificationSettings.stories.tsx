import type {
	NotificationPreferences,
	UpdateNotificationDelivery,
	UpdateNotificationPreference,
} from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { NotificationSettings } from "./NotificationSettings.tsx";

const preferencesUrl = `${import.meta.env.VITE_API_URL}/notifications/preferences`;
const deliveryUrl = `${import.meta.env.VITE_API_URL}/notifications/delivery`;

const defaults: NotificationPreferences = {
	kinds: { approve: true, dm: true, mention: true, routine: false, collab: false },
	delivery: { desktop: true, quietOnWeekends: false },
};

function QueryPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">{children}</div>
		</QueryClientProvider>
	);
}

/**
 * Makes the browser answer `permission` about showing notices, until the
 * returned cleanup puts its own answer back.
 */
function browserPermission(permission: NotificationPermission) {
	const original = Object.getOwnPropertyDescriptor(window, "Notification");
	Object.defineProperty(window, "Notification", {
		configurable: true,
		writable: true,
		value: { permission, requestPermission: async () => permission },
	});
	return () => {
		if (original) Object.defineProperty(window, "Notification", original);
	};
}

const meta = preview.meta({
	title: "Views/NotificationSettings",
	component: NotificationSettings,
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "600px" } },
	},
	decorators: [
		(Story, context) => (
			<QueryPreview key={context.id}>
				<Story />
			</QueryPreview>
		),
	],
});

/** Somebody who has chosen nothing yet, in a browser that allows notices, gets each default. */
export const Defaults = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(preferencesUrl, () => HttpResponse.json(defaults)));
		return browserPermission("granted");
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Tell me when")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "A bot needs my approval" })).toBeChecked();
		await expect(canvas.getByRole("switch", { name: "A bot messages me directly" })).toBeChecked();
		await expect(
			canvas.getByRole("switch", { name: "Someone mentions me in a pod" }),
		).toBeChecked();
		await expect(canvas.getByRole("switch", { name: "A routine finishes" })).not.toBeChecked();
		await expect(
			canvas.getByRole("switch", { name: "A collaboration finishes" }),
		).not.toBeChecked();
		await expect(canvas.getByRole("switch", { name: "Desktop notifications" })).toBeChecked();
		await expect(canvas.getByRole("switch", { name: "Quiet on weekends" })).not.toBeChecked();
		await expect(canvas.queryByText(/browser/)).not.toBeInTheDocument();
	},
});

/** Turning a kind off saves that one kind, and the switch stays where it was put. */
export const TurningOneOff = meta.story({
	beforeEach({ msw }) {
		let stored = defaults;
		msw.use(
			http.get(preferencesUrl, () => HttpResponse.json(stored)),
			http.patch(preferencesUrl, async ({ request }) => {
				const { kind, enabled } = (await request.json()) as UpdateNotificationPreference;
				stored = { ...stored, kinds: { ...stored.kinds, [kind]: enabled } };
				return HttpResponse.json(stored);
			}),
		);
		return browserPermission("granted");
	},
	play: async ({ canvas, userEvent }) => {
		const approvals = await canvas.findByRole("switch", { name: "A bot needs my approval" });

		await userEvent.click(approvals);

		await waitFor(() => expect(approvals).not.toBeChecked());
		await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
	},
});

/** Turning on quiet weekends saves that one setting, and the switch stays where it was put. */
export const TurningOnQuietWeekends = meta.story({
	beforeEach({ msw }) {
		let stored = defaults;
		msw.use(
			http.get(preferencesUrl, () => HttpResponse.json(stored)),
			http.patch(deliveryUrl, async ({ request }) => {
				const change = (await request.json()) as UpdateNotificationDelivery;
				stored = { ...stored, delivery: { ...stored.delivery, ...change } };
				return HttpResponse.json(stored);
			}),
		);
		return browserPermission("granted");
	},
	play: async ({ canvas, userEvent }) => {
		const quiet = await canvas.findByRole("switch", { name: "Quiet on weekends" });

		await userEvent.click(quiet);

		await waitFor(() => expect(quiet).toBeChecked());
		await expect(canvas.getByRole("switch", { name: "Desktop notifications" })).toBeChecked();
		await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
	},
});

/** A save that fails puts the switch back and says why. */
export const SaveFails = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(preferencesUrl, () => HttpResponse.json(defaults)),
			http.patch(preferencesUrl, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "Internal server error" },
					{ status: 500 },
				),
			),
		);
		return browserPermission("granted");
	},
	play: async ({ canvas, userEvent }) => {
		const approvals = await canvas.findByRole("switch", { name: "A bot needs my approval" });

		await userEvent.click(approvals);

		await expect(await canvas.findByRole("alert")).toBeInTheDocument();
		await expect(approvals).toBeChecked();
	},
});

/** Desktop notices are on but the browser has not been asked, so the row offers to ask it. */
export const DesktopNotAllowedYet = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(preferencesUrl, () => HttpResponse.json(defaults)));
		return browserPermission("default");
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Allow in this browser" }),
		).toBeInTheDocument();
	},
});

/** The browser blocks notices from Sugabots, so the row says where to allow them. */
export const DesktopBlocked = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(preferencesUrl, () => HttpResponse.json(defaults)));
		return browserPermission("denied");
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Blocked in this browser's settings")).toBeInTheDocument();
	},
});
