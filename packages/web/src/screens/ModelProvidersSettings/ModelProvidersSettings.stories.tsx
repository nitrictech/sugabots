import type { ModelProvider } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { delay, HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { ModelProvidersSettings } from "./index.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const provider: ModelProvider = {
	id: "0199a3a0-0000-7000-8000-000000000002",
	workspaceId: workspace.id,
	preset: "openai",
	name: "OpenAI",
	baseUrl: "https://api.openai.com/v1",
	apiFormat: "openai",
	active: true,
	status: "connected",
	hasApiKey: true,
	apiKeyHint: "1234",
	signedIn: false,
	customHeaders: [],
	modelCount: 1,
	enabledModelCount: 1,
	lastTestedAt: "2026-09-01T00:00:00.000Z",
	lastTestError: null,
	models: [
		{
			id: "0199a3a0-0000-7000-8000-000000000003",
			modelId: "gpt-5",
			displayName: null,
			capabilities: ["tools", "vision"],
			disabledCapabilities: [],
			contextLength: null,
			enabled: true,
			source: "fetched",
		},
	],
};

const providersUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/model-providers`;

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex h-screen flex-col bg-card">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/ModelProvidersSettings",
	component: ModelProvidersSettings,
	tags: ["ai-generated"],
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
			http.get(`${import.meta.env.VITE_API_URL}/auth/organization/list`, () =>
				HttpResponse.json([workspace]),
			),
			http.get(providersUrl, () => HttpResponse.json([provider])),
			http.all(`${providersUrl}/*`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not save provider changes." },
					{ status: 500 },
				),
			),
			http.post(providersUrl, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not create providers." },
					{ status: 500 },
				),
			),
		);
	},
});

/** Connected shows the production settings screen with a configured provider. */
export const Connected = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "OpenAI On" }));
		await expect(await canvas.findByRole("heading", { name: "OpenAI" })).toBeVisible();
	},
});

/** RailStates puts an active and an inactive provider side by side in the rail. */
export const RailStates = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(providersUrl, () =>
				HttpResponse.json([
					provider,
					{
						...provider,
						id: "0199a3a0-0000-7000-8000-000000000004",
						preset: "ollama",
						name: "Ollama",
						baseUrl: "http://localhost:11434",
						active: false,
					},
				]),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "OpenAI On" })).toBeVisible();
		await expect(await canvas.findByRole("button", { name: "Ollama Off" })).toBeVisible();
	},
});

/** Empty exposes the add-provider entry point before the workspace is configured. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(providersUrl, () => HttpResponse.json([])));
	},
	play: async ({ canvas }) => {
		const providers = await canvas.findByRole("navigation", { name: "Model providers" });
		await expect(within(providers).queryAllByRole("button")).toHaveLength(0);
		await expect(canvas.getAllByRole("button", { name: "Add provider" })[0]).toBeVisible();
	},
});

/** Loading holds the request open so the loading state can be reviewed reliably. */
export const Loading = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(providersUrl, async () => {
				await delay("infinite");
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Loading providers...")).toBeVisible();
	},
});

/** LoadFailed displays a server error without needing to break a real backend. */
export const LoadFailed = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(providersUrl, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "Providers are temporarily unavailable." },
					{ status: 500 },
				),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Providers are temporarily unavailable.")).toBeVisible();
	},
});

/** SearchWithoutResults keeps the provider context visible when no models match. */
export const SearchWithoutResults = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "OpenAI On" }));
		await userEvent.type(
			await canvas.findByRole("textbox", { name: "Search models" }),
			"unavailable-model",
		);
		await expect(canvas.getByText("No models match your search.")).toBeVisible();
	},
});

const chatgpt: ModelProvider = {
	...provider,
	id: "0199a3a0-0000-7000-8000-000000000005",
	preset: "chatgpt",
	name: "ChatGPT",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	active: false,
	status: "signed_out",
	hasApiKey: false,
	apiKeyHint: null,
	modelCount: 0,
	enabledModelCount: 0,
	lastTestedAt: null,
	models: [],
};

/** ChatgptSignIn shows the code to enter on OpenAI's site while the page waits for the sign-in. */
export const ChatgptSignIn = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(providersUrl, () => HttpResponse.json([chatgpt])),
			http.post(`${providersUrl}/${chatgpt.id}/chatgpt-sign-in`, () =>
				HttpResponse.json({
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
					attempt: "sealed-attempt",
					pollIntervalMs: 60_000,
					expiresAt: "2026-09-01T00:15:00.000Z",
				}),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "ChatGPT Off" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Sign in with ChatGPT" }));
		const warning = within(await screen.findByRole("dialog"));
		await expect(warning.getByText("For single-user installs only")).toBeVisible();
		await expect(warning.getByRole("link", { name: "OpenAI's terms" })).toHaveAttribute(
			"href",
			"https://openai.com/policies/terms-of-use/#registration-and-access",
		);
		await userEvent.click(warning.getByRole("button", { name: "I understand, sign in" }));
		await expect(await canvas.findByText("ABCD-1234")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Copy code" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute(
			"href",
			"https://auth.openai.com/codex/device",
		);
	},
});

/** ChatgptSignedIn is a ChatGPT provider after sign-in, with the plan's models listed. */
export const ChatgptSignedIn = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(providersUrl, () =>
				HttpResponse.json([
					{
						...chatgpt,
						active: true,
						status: "connected",
						signedIn: true,
						modelCount: 1,
						enabledModelCount: 1,
						lastTestedAt: "2026-09-01T00:00:00.000Z",
						models: [{ ...provider.models[0], modelId: "gpt-5.5", displayName: "GPT-5.5" }],
					},
				]),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "ChatGPT On" }));
		await expect(await canvas.findByText("Signed in with ChatGPT")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeVisible();
	},
});
