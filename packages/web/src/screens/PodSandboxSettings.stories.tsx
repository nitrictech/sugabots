import type { PodSandbox, PodSandboxNetwork, SandboxDisk } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { storyBots } from "../story-app.tsx";
import { PodSandboxSettings } from "./PodSandboxSettings.tsx";

const podId = "0199a3a0-0000-7000-8000-000000000601";
const sandboxUrl = `${import.meta.env.VITE_API_URL}/pods/${podId}/sandbox`;

const [builder, reviewer] = storyBots;
const bots = [builder, reviewer].filter((bot) => bot !== undefined);

const GB = 1024 ** 3;
const bytes = (gigabytes: number) => Math.round(gigabytes * GB);

/** A 20 GB disk with `usedGB` of it used: two bots' homes, the threads, /tmp, and the system. */
const diskWith = (usedGB: number): SandboxDisk => ({
	usedBytes: bytes(usedGB),
	totalBytes: bytes(20),
	measuredAt: "2026-10-02T05:38:00.000Z",
	folders: [
		{ kind: "threads", bytes: bytes(usedGB * 0.45) },
		{ kind: "home", agentId: builder?.id ?? "", bytes: bytes(usedGB * 0.25) },
		{ kind: "temporary", bytes: bytes(usedGB * 0.1) },
		{ kind: "home", agentId: reviewer?.id ?? "", bytes: bytes(usedGB * 0.05) },
	],
});

const image =
	"ghcr.io/nitrictech/sugabots-sandbox@sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

const running: PodSandbox = {
	sandbox: {
		kind: "present",
		state: "running",
		image,
		providerName: "OpenSandbox",
		createdAt: "2026-09-29T09:00:00.000Z",
		lastUsedAt: "2026-10-02T05:40:00.000Z",
		turnsUsing: 0,
		peopleWatching: 0,
		upgradeAvailable: false,
		disk: diskWith(6.2),
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
	mode: "allowlist",
	blocking: true,
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
	args: { podId, bots, canManageNetwork: true },
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
		await expect(canvas.getByText(image)).toBeVisible();
		await expect(canvas.getByText("Running")).toBeVisible();
		await expect(canvas.getByText("Reset")).toBeVisible();
		await expect(await canvas.findByText("api.stripe.com")).toBeVisible();
		await expect(canvas.getByLabelText("Add host")).toBeVisible();
	},
});

/**
 * Its disk, with what each bot's home, the threads' folders and /tmp take of
 * it, largest first, and the rest the system's.
 */
export const Disk = meta.story({
	play: async ({ canvas }) => {
		const disk = await canvas.findByRole("region", { name: "Disk" });
		await expect(within(disk).getByText("6.2 GB of 20 GB used")).toBeVisible();
		await expect(within(disk).getByRole("meter", { name: "Disk used" })).toHaveValue(31);
		await expect(within(disk).getByText("Thread folders")).toBeVisible();
		await expect(within(disk).getByText(builder?.name ?? "")).toBeVisible();
		await expect(within(disk).getByText("Everything else")).toBeVisible();
		await expect(within(disk).queryByText(/Nearly full|Almost full/)).toBeNull();
	},
});

/** Past 80%: the bar and the share turn amber, and the note says what to do. */
export const DiskNearlyFull = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ disk: diskWith(16.6) })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("83%")).toBeVisible();
		await expect(canvas.getByText(/^Nearly full/)).toBeVisible();
	},
});

/** Past 90%: red, since commands that write are about to fail. */
export const DiskAlmostFull = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ disk: diskWith(19.4) })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("97%")).toBeVisible();
		await expect(canvas.getByText(/^Almost full/)).toBeVisible();
	},
});

/** Made before disks were measured, or not on since: nothing to show yet. */
export const DiskNotMeasured = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ disk: null })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Not measured yet")).toBeVisible();
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

/** In use by a bot and watched: the actions wait until the bot has finished. */
export const InUse = meta.story({
	beforeEach({ msw }) {
		msw.use(answers(present({ turnsUsing: 1, peopleWatching: 2 })));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("A bot is using it, 2 people watching")).toBeVisible();
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
		await expect(await canvas.findByText("No computer yet")).toBeVisible();
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
