import type { PodSandbox, PodSandboxNetwork } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { PodSandboxSettings } from "./PodSandboxSettings.tsx";

const podId = "0199a3a0-0000-7000-8000-000000000601";
const sandboxUrl = `${import.meta.env.VITE_API_URL}/pods/${podId}/sandbox`;

const running: PodSandbox = {
	sandbox: {
		kind: "present",
		state: "running",
		image: "ghcr.io/nitrictech/sugabots-sandbox:latest",
		providerName: "OpenSandbox",
		createdAt: "2026-09-29T09:00:00.000Z",
		lastUsedAt: "2026-10-02T05:40:00.000Z",
		turnsUsing: 0,
		upgradeAvailable: false,
	},
	providerEnabled: true,
	canManage: true,
};

const present = (over: Partial<Extract<PodSandbox["sandbox"], { kind: "present" }>>) => ({
	...running,
	sandbox: { ...(running.sandbox as Extract<PodSandbox["sandbox"], { kind: "present" }>), ...over },
});

function Preview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Platform">{children}</SettingsPage>
			</div>
		</QueryClientProvider>
	);
}

const answers = (shown: PodSandbox) => http.get(sandboxUrl, () => HttpResponse.json(shown));

const network: PodSandboxNetwork = {
	workspaceHosts: [
		{ host: "github.com", blockedBy: null },
		{ host: "registry.npmjs.org", blockedBy: null },
	],
	addedHosts: [
		{
			host: "api.stripe.com",
			addedByName: "Sam Rivera",
			addedAt: "2026-10-01T09:30:00.000Z",
			blockedBy: null,
		},
	],
};

const meta = preview.meta({
	title: "Views/PodSandboxSettings",
	component: PodSandboxSettings,
	tags: ["ai-generated"],
	args: { podId, canManageNetwork: true },
	parameters: { layout: "fullscreen", docs: { story: { inline: false, height: "520px" } } },
	decorators: [
		(Story, context) => (
			<Preview key={context.id}>
				<Story />
			</Preview>
		),
	],
	beforeEach({ msw }) {
		msw.use(
			answers(running),
			http.get(`${sandboxUrl}/network`, () => HttpResponse.json(network)),
			http.post(`${sandboxUrl}/*`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not change sandboxes." },
					{ status: 500 },
				),
			),
		);
	},
});

/** A running sandbox, to someone who looks after the pod: its image, activity, the two actions, and its hosts. */
export const Running = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("OpenSandbox")).toBeVisible();
		await expect(canvas.getByText("ghcr.io/nitrictech/sugabots-sandbox:latest")).toBeVisible();
		await expect(canvas.getByText("Running")).toBeVisible();
		await expect(canvas.getByText("Reset")).toBeVisible();
		await expect(await canvas.findByText("api.stripe.com")).toBeVisible();
		await expect(canvas.getByLabelText("Add host")).toBeVisible();
	},
});

/** Paused, with an upgrade waiting because the provider now makes sandboxes from another image. */
export const PausedWithUpgrade = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ state: "paused", upgradeAvailable: true })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Upgrade available")).toBeVisible();
		await expect(canvas.getByText(/Paused while nobody uses it/)).toBeVisible();
	},
});

/** In use by a bot: the actions wait until it has finished. */
export const InUse = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ turnsUsing: 1 })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("A bot is using it")).toBeVisible();
	},
});

/** The provider lost it: the next use makes a new one. */
export const Lost = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ state: "lost", image: null })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/no longer has this sandbox/)).toBeVisible();
	},
});

/** Nothing made yet. */
export const NoneYet = meta.story({
	beforeEach({ msw }) {
		msw.use(answers({ sandbox: { kind: "none" }, providerEnabled: true, canManage: true }));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("No sandbox yet")).toBeVisible();
	},
});

/** Someone who can see the pod but not change it sees how it stands, without the actions. */
export const AsAMember = meta.story({
	args: { canManageNetwork: false },
	beforeEach({ msw }) {
		msw.use(answers({ ...running, canManage: false }));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("OpenSandbox")).toBeVisible();
		await expect(canvas.queryByText("Reset")).toBeNull();
		await expect(await canvas.findByText("api.stripe.com")).toBeVisible();
		await expect(canvas.queryByLabelText("Add host")).toBeNull();
	},
});
