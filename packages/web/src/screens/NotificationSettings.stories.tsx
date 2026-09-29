import type { NotificationPreferences, UpdateNotificationPreference } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { NotificationSettings } from "./NotificationSettings.tsx";

const preferencesUrl = `${import.meta.env.VITE_API_URL}/notifications/preferences`;

const defaults: NotificationPreferences = { approve: true };

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

/** Somebody who has chosen nothing yet hears about what each kind's default says. */
export const Defaults = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(preferencesUrl, () => HttpResponse.json(defaults)));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Tell me when")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "A bot needs my approval" })).toBeChecked();
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
				stored = { ...stored, [kind]: enabled };
				return HttpResponse.json(stored);
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const approvals = await canvas.findByRole("switch", { name: "A bot needs my approval" });

		await userEvent.click(approvals);

		await waitFor(() => expect(approvals).not.toBeChecked());
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
	},
	play: async ({ canvas, userEvent }) => {
		const approvals = await canvas.findByRole("switch", { name: "A bot needs my approval" });

		await userEvent.click(approvals);

		await expect(await canvas.findByRole("alert")).toBeInTheDocument();
		await expect(approvals).toBeChecked();
	},
});
