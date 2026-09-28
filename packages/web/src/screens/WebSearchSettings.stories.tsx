import type { SearchProvider } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { WebSearchSettings } from "./WebSearchSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	timeZone: "UTC",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const brave: SearchProvider = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	workspaceId: workspace.id,
	preset: "brave",
	name: "Brave Search",
	baseUrl: "https://api.search.brave.com/res/v1",
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	apiKeyHint: null,
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-09-14T00:00:00.000Z",
};

const providerUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/search-provider`;

const answers = (provider: SearchProvider | null) =>
	http.get(providerUrl, () => HttpResponse.json({ provider }));

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Web search" description="How bots look things up online.">
					{children}
				</SettingsPage>
			</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/WebSearchSettings",
	component: WebSearchSettings,
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "720px" } },
	},
	decorators: [
		(Story, context) => (
			<SettingsPreview key={context.id}>
				<Story />
			</SettingsPreview>
		),
	],
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/workspaces`, () => HttpResponse.json([workspace])),
			answers(null),
			http.all(`${providerUrl}*`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not save search settings." },
					{ status: 500 },
				),
			),
		);
	},
});

/** A fresh workspace: search is off, and who answers is tucked under Advanced. */
export const Off = meta.story({
	play: async ({ canvas }) => {
		const power = await canvas.findByRole("switch", { name: "Bots can use the web" });
		await expect(power).toHaveAttribute("aria-checked", "false");
		await expect(canvas.getByRole("button", { name: "Show advanced" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	},
});

/** Advanced open on Exa, the provider until another is chosen, whose key is optional. */
export const Providers = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers({
				...brave,
				preset: "exa",
				name: "Exa",
				baseUrl: "https://api.exa.ai",
				enabled: true,
				status: "connected",
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Show advanced" }));
		await expect(canvas.getByRole("radio", { name: /Exa/ })).toBeChecked();
		await expect(canvas.getByText("The last test search worked.")).toBeInTheDocument();
	},
});

/**
 * A provider that needs a key and has none holds the switch off, and opens
 * Advanced so the key it is waiting for is in view.
 */
export const NeedsKey = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(brave));
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("switch", { name: "Bots can use the web" }),
		).toBeDisabled();
		await expect(canvas.getByPlaceholderText("Paste your key")).toBeInTheDocument();
	},
});

/** A saved key shows only its hint, with Replace and Remove beside it. */
export const KeySaved = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers({
				...brave,
				enabled: true,
				status: "untested",
				hasApiKey: true,
				apiKeyHint: "…8f2a",
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Show advanced" }));
		await expect(canvas.getByText("…8f2a")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Replace" })).toBeInTheDocument();
	},
});
