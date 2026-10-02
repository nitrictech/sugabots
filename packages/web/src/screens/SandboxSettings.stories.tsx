import type { SandboxNetworkSettings, SandboxProvider } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { SandboxSettings } from "./SandboxSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	timeZone: "UTC",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const openSandbox: SandboxProvider = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	workspaceId: workspace.id,
	preset: "opensandbox",
	name: "OpenSandbox",
	baseUrl: "http://localhost:8090",
	sandboxUrl: null,
	image: null,
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-10-01T00:00:00.000Z",
};

const providersUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/sandbox-providers`;

const network: SandboxNetworkSettings = {
	trustedHosts: ["github.com", "*.github.com", "registry.npmjs.org", "pypi.org"],
	addedHosts: [],
	blockedHosts: [],
};

const answers = (providers: readonly SandboxProvider[]) =>
	http.get(providersUrl, () => HttpResponse.json(providers));

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Sandboxes" description="Where bots run commands and edit files.">
					{children}
				</SettingsPage>
			</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/SandboxSettings",
	component: SandboxSettings,
	tags: ["ai-generated"],
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "820px" } },
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
			answers([]),
			http.get(`${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/sandbox-network`, () =>
				HttpResponse.json(network),
			),
			http.get(`${providersUrl}/:providerId/template`, () => HttpResponse.json({ state: "ready" })),
			http.all(`${providersUrl}*`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not save sandbox settings." },
					{ status: 500 },
				),
			),
		);
	},
});

/** A workspace with no provider yet: the switch waits for OpenSandbox's key. */
export const Off = meta.story({
	play: async ({ canvas }) => {
		const power = await canvas.findByRole("switch", { name: "Bots can use a sandbox" });
		await expect(power).toBeDisabled();
		await expect(canvas.getByRole("radio", { name: /OpenSandbox/ })).toBeChecked();
		await expect(canvas.getByPlaceholderText("Paste your key")).toBeInTheDocument();
	},
});

/** OpenSandbox in use, with a saved key and a passing test. */
export const InUse = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...openSandbox,
					enabled: true,
					hasApiKey: true,
					status: "connected",
					lastTestedAt: "2026-10-02T00:00:00.000Z",
				},
			]),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("switch", { name: "Bots can use a sandbox" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(canvas.getByText("The last test connected.")).toBeInTheDocument();
		await expect(canvas.getByText("In use")).toBeInTheDocument();
	},
});

/**
 * E2B chosen while OpenSandbox is in use: its fields include E2B Embed's two
 * addresses, and turning it on says pods get new sandboxes.
 */
export const SwitchingProvider = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{ ...openSandbox, enabled: true, hasApiKey: true, status: "connected" },
				{
					...openSandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					preset: "e2b",
					name: "E2B",
					baseUrl: null,
					image: null,
					hasApiKey: true,
					status: "untested",
				},
			]),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("radio", { name: /E2B/ }));
		await expect(canvas.getByLabelText("Template")).toHaveAttribute(
			"placeholder",
			"sugabots-sandbox",
		);
		await expect(canvas.getByLabelText("Sandbox URL")).toBeInTheDocument();
		await expect(canvas.getByText(/moves sandboxes from OpenSandbox to E2B/)).toBeInTheDocument();
	},
});

/** E2B with a key but no Sugabots template yet: preparing it builds the image into the workspace's E2B account. */
export const E2bTemplateMissing = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...openSandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					preset: "e2b",
					name: "E2B",
					baseUrl: null,
					image: null,
					hasApiKey: true,
					status: "untested",
				},
			]),
			http.get(`${providersUrl}/:providerId/template`, () =>
				HttpResponse.json({ state: "missing" }),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Prepare template")).toBeVisible();
		await expect(canvas.getByText(/into a template in your E2B account/)).toBeVisible();
	},
});
