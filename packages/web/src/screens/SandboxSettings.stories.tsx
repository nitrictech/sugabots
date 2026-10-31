import type {
	SandboxNetworkSettings,
	SandboxProvider,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyBots, storyWorkspace } from "../story-app.tsx";

/*
 * Computers, as the app shows them in settings: the switch for whether bots
 * get one, the provider and its account, what the computers may reach, and
 * the bots using one.
 */

const computers = `/${storyWorkspace.slug}/settings/sandboxes`;
const api = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;

const openSandbox: SandboxProvider = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	workspaceId: storyWorkspace.id,
	preset: "opensandbox",
	name: "OpenSandbox",
	settings: { preset: "opensandbox", serverUrl: "http://localhost:8090" },
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	lastTestedAt: null,
	lastTestError: null,
	createdAt: "2026-10-01T00:00:00.000Z",
};

const providersUrl = api(`/workspaces/${storyWorkspace.id}/sandbox-providers`);
const networkUrl = api(`/workspaces/${storyWorkspace.id}/sandbox-network`);

const network: SandboxNetworkSettings = {
	mode: "open",
	blocking: true,
	trustedHosts: ["github.com", "*.github.com", "registry.npmjs.org", "pypi.org"],
	addedHosts: [],
	blockedHosts: [],
};

const answers = (providers: readonly SandboxProvider[]) =>
	http.get(providersUrl, () => HttpResponse.json(providers));

const meta = preview.meta({
	title: "Views/Computers",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	render: () => <StoryApp path={computers} />,
	beforeEach({ msw }) {
		msw.use(
			...appHandlers(),
			answers([]),
			http.get(networkUrl, () => HttpResponse.json(network)),
			http.get(`${providersUrl}/:providerId/template`, () => HttpResponse.json({ state: "ready" })),
			http.all(`${providersUrl}*`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "This preview does not save computer settings." },
					{ status: 500 },
				),
			),
		);
	},
});

/**
 * A workspace with no provider yet: the experimental notice, the switch
 * waiting for OpenSandbox's key, and no bot using a computer yet.
 */
export const Off = meta.story({
	play: async ({ canvas }) => {
		const power = await canvas.findByRole(
			"switch",
			{ name: "Bots can use a computer" },
			{ timeout: 10_000 },
		);
		await expect(power).toBeDisabled();
		await expect(canvas.getByText(/Computers are experimental/)).toBeInTheDocument();
		await expect(
			canvas.getByText("OpenSandbox needs an API key first. Add it below."),
		).toBeVisible();
		await expect(canvas.getByRole("radio", { name: /OpenSandbox/ })).toBeChecked();
		await expect(canvas.getByPlaceholderText("Paste your key")).toBeInTheDocument();
		const using = canvas.getByRole("region", { name: "Bots using a computer" });
		await expect(within(using).getByText("None yet")).toBeInTheDocument();
	},
});

/** The bots with their computer on, each under its pod's name and opening its own settings. */
export const BotsUsingAComputer = meta.story({
	beforeEach({ msw }) {
		const [first, second] = storyBots;
		msw.use(
			...appHandlers({
				bots: storyBots.map((bot) =>
					bot.id === first?.id || bot.id === second?.id ? { ...bot, usesSandbox: true } : bot,
				),
			}),
			answers([{ ...openSandbox, enabled: true, hasApiKey: true, status: "connected" }]),
			http.get(networkUrl, () => HttpResponse.json(network)),
		);
	},
	play: async ({ canvas }) => {
		const using = await canvas.findByRole(
			"region",
			{ name: "Bots using a computer" },
			{ timeout: 10_000 },
		);
		const [first] = storyBots;
		const row = await within(using).findByRole("link", { name: new RegExp(`^${first?.name}`) });
		await expect(row).toHaveAttribute(
			"href",
			expect.stringMatching(/\/settings\/pods\/.+\/agents\//),
		);
		await expect(within(using).getAllByRole("link")).toHaveLength(2);
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
			await canvas.findByRole("switch", { name: "Bots can use a computer" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(canvas.getByText("The last test connected.")).toBeInTheDocument();
		await expect(canvas.getByText("In use")).toBeInTheDocument();
		await expect(await canvas.findByRole("radio", { name: "Open" })).toBeChecked();
	},
});

const savedChanges = fn<(changes: SandboxProviderUpdate) => void>();

/**
 * OpenSandbox open to every host but the blocked ones. Going back to the
 * allowlist saves it in the provider's settings.
 */
export const OpenNetwork = meta.story({
	beforeEach({ msw }) {
		savedChanges.mockClear();
		const provider: SandboxProvider = {
			...openSandbox,
			settings: { ...openSandbox.settings, preset: "opensandbox", networkMode: "open" },
			enabled: true,
			hasApiKey: true,
			status: "connected",
		};
		msw.use(
			answers([provider]),
			http.get(networkUrl, () => HttpResponse.json({ ...network, mode: "open" })),
			http.patch(`${providersUrl}/:providerId`, async ({ request }) => {
				const changes = (await request.json()) as SandboxProviderUpdate;
				savedChanges(changes);
				return HttpResponse.json({ ...provider, settings: changes.settings });
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByRole("radio", { name: "Open" })).toBeChecked();
		await expect(await canvas.findByText(/Any host but the blocked ones/)).toBeInTheDocument();

		await userEvent.click(canvas.getByRole("radio", { name: "Allowlist" }));
		await waitFor(() =>
			expect(savedChanges).toHaveBeenCalledWith({
				settings: {
					preset: "opensandbox",
					serverUrl: "http://localhost:8090",
					networkMode: "allowlist",
				},
			}),
		);
	},
});

/**
 * E2B chosen while OpenSandbox is in use: its fields include E2B Embed's two
 * addresses, and turning it on says pods get new computers.
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
					settings: { preset: "e2b" },
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
		await expect(canvas.getByLabelText("Computer URL")).toBeInTheDocument();
		await expect(canvas.getByText(/moves computers from OpenSandbox to E2B/)).toBeInTheDocument();
		await expect(await canvas.findByRole("radio", { name: "Open" })).toBeChecked();
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
					settings: { preset: "e2b" },
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

/** E2B with its template built: rebuilding takes a newer Sugabots image. */
export const E2bTemplateReady = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...openSandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					preset: "e2b",
					name: "E2B",
					settings: { preset: "e2b" },
					hasApiKey: true,
					status: "connected",
				},
			]),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: /Rebuild template/ })).toBeVisible();
		await expect(canvas.getByText(/Sugabots' latest image/)).toBeVisible();
	},
});

/** OpenSandbox sized beyond its default. */
export const OpenSandboxCustomSize = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...openSandbox,
					settings: { ...openSandbox.settings, preset: "opensandbox", cpuCount: 4, memoryGiB: 8 },
					hasApiKey: true,
					status: "connected",
				},
			]),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByLabelText("vCPUs")).toHaveValue("4");
		await expect(canvas.getByLabelText("Memory")).toHaveValue("8 GiB");
	},
});

/** E2B sized beyond its default; a size that isn't a whole number is refused before it's saved. */
export const E2bCustomSize = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...openSandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					preset: "e2b",
					name: "E2B",
					settings: { preset: "e2b", cpuCount: 4, memoryGiB: 8 },
					hasApiKey: true,
					status: "connected",
				},
			]),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const vcpus = await canvas.findByLabelText("vCPUs");
		await expect(vcpus).toHaveValue("4");
		await expect(canvas.getByLabelText("Memory")).toHaveValue("8 GiB");

		await userEvent.clear(vcpus);
		await userEvent.type(vcpus, "2.5{Enter}");
		await expect(await canvas.findByText(/whole number of vCPUs/)).toBeVisible();
	},
});
