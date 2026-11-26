import type {
	ComputerNetworkSettings,
	ComputerProvider,
	ComputerProviderUpdate,
	ProjectComputerDisk,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { storyBots } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	StoryApp,
	storyProjects,
	storyWorkspace,
} from "../story-app.test-support.tsx";

/*
 * Computers, as the app shows them in settings: the switch for whether
 * projects and bots get one, the provider and its account, what the
 * computers may reach, the bots using one, and how full each one's disk is.
 */

const computers = `/${storyWorkspace.slug}?settings=computers`;
const api = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;

const opensandbox: ComputerProvider = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	workspaceId: storyWorkspace.id,
	builtIn: "opensandbox",
	name: "OpenSandbox",
	settings: { builtIn: "opensandbox", serverUrl: "http://localhost:8090" },
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	lastTestError: null,
	createdAt: "2026-10-01T00:00:00.000Z",
};

const providersUrl = api(`/workspaces/${storyWorkspace.id}/computer-providers`);
const networkUrl = api(`/workspaces/${storyWorkspace.id}/computer-network`);
const disksUrl = api(`/workspaces/${storyWorkspace.id}/computer-disks`);

const network: ComputerNetworkSettings = {
	mode: "open",
	blocking: true,
	trustedHosts: ["github.com", "*.github.com", "registry.npmjs.org", "pypi.org"],
	addedHosts: [],
	blockedHosts: [],
};

const answers = (providers: readonly ComputerProvider[]) =>
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
			http.get(disksUrl, () => HttpResponse.json([])),
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
		const power = await canvas.findByRole("switch", { name: "Bots can use a computer" });
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

/** The bots with their computer on, each opening its own settings. */
export const BotsUsingAComputer = meta.story({
	beforeEach({ msw }) {
		const [first, second] = storyBots;
		msw.use(
			...appHandlers({
				bots: storyBots.map((bot) =>
					bot.id === first?.id || bot.id === second?.id ? { ...bot, usesComputer: true } : bot,
				),
			}),
			answers([{ ...opensandbox, enabled: true, hasApiKey: true, status: "connected" }]),
			http.get(networkUrl, () => HttpResponse.json(network)),
		);
	},
	play: async ({ canvas }) => {
		const using = await canvas.findByRole("region", { name: "Bots using a computer" });
		const [first] = storyBots;
		const row = await within(using).findByRole("link", { name: new RegExp(`^${first?.name}`) });
		await expect(row).toHaveAttribute("href", expect.stringMatching(/\/bots\/[^/]+\/settings$/));
		await expect(within(using).getAllByRole("link")).toHaveLength(2);
	},
});

/** OpenSandbox in use, with a saved key and a passing test. */
export const InUse = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{
					...opensandbox,
					enabled: true,
					hasApiKey: true,
					status: "connected",
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

const savedChanges = fn<(changes: ComputerProviderUpdate) => void>();

/**
 * OpenSandbox open to every host but the blocked ones. Going back to
 * allowed hosts only saves it in the provider's settings.
 */
export const OpenNetwork = meta.story({
	beforeEach({ msw }) {
		savedChanges.mockClear();
		const provider: ComputerProvider = {
			...opensandbox,
			settings: { ...opensandbox.settings, builtIn: "opensandbox", networkMode: "open" },
			enabled: true,
			hasApiKey: true,
			status: "connected",
		};
		msw.use(
			answers([provider]),
			http.get(networkUrl, () => HttpResponse.json({ ...network, mode: "open" })),
			http.patch(`${providersUrl}/:providerId`, async ({ request }) => {
				const changes = (await request.json()) as ComputerProviderUpdate;
				savedChanges(changes);
				return HttpResponse.json({ ...provider, settings: changes.settings });
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByRole("radio", { name: "Open" })).toBeChecked();
		await expect(await canvas.findByText(/Any host but the blocked ones/)).toBeInTheDocument();

		await userEvent.click(canvas.getByRole("radio", { name: "Allowed hosts only" }));
		await waitFor(() =>
			expect(savedChanges).toHaveBeenCalledWith({
				settings: {
					builtIn: "opensandbox",
					serverUrl: "http://localhost:8090",
					networkMode: "allowed-hosts-only",
				},
			}),
		);
	},
});

/**
 * E2B chosen while OpenSandbox is in use: its fields include E2B Embed's two
 * addresses, and turning it on says bots get new computers.
 */
export const SwitchingProvider = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answers([
				{ ...opensandbox, enabled: true, hasApiKey: true, status: "connected" },
				{
					...opensandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					builtIn: "e2b",
					name: "E2B",
					settings: { builtIn: "e2b" },
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
					...opensandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					builtIn: "e2b",
					name: "E2B",
					settings: { builtIn: "e2b" },
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
					...opensandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					builtIn: "e2b",
					name: "E2B",
					settings: { builtIn: "e2b" },
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
					...opensandbox,
					settings: { ...opensandbox.settings, builtIn: "opensandbox", cpuCount: 4, memoryGiB: 8 },
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
					...opensandbox,
					id: "0199a3a0-0000-7000-8000-0000000000f2",
					builtIn: "e2b",
					name: "E2B",
					settings: { builtIn: "e2b", cpuCount: 4, memoryGiB: 8 },
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

const GB = 1024 ** 3;

/** A project's 20 GB disk, with `usedGB` of it used. */
const projectDisk = (projectId: string, usedGB: number): ProjectComputerDisk => ({
	projectId,
	disk: {
		usedBytes: Math.round(usedGB * GB),
		totalBytes: 20 * GB,
		measuredAt: "2026-10-02T05:38:00.000Z",
		folders: null,
	},
});

/**
 * How full each computer's disk is, fullest first, named by its project or
 * by the bot whose default project it is, each opening that Computer page.
 */
export const DiskUse = meta.story({
	beforeEach({ msw }) {
		const [first, second] = storyBots;
		msw.use(
			answers([{ ...opensandbox, enabled: true, hasApiKey: true, status: "connected" }]),
			http.get(disksUrl, () =>
				HttpResponse.json([
					projectDisk(first?.defaultProjectId ?? "", 4.1),
					projectDisk(second?.defaultProjectId ?? "", 18.6),
					projectDisk(storyProjects[0]?.id ?? "", 9.3),
				]),
			),
		);
	},
	play: async ({ canvas }) => {
		const disks = await canvas.findByRole("region", { name: "Disk use" });
		const [first, second] = storyBots;
		const rows = within(disks).getAllByRole("link");
		await expect(rows).toHaveLength(3);
		await expect(rows[0]).toHaveTextContent(second?.name ?? "");
		await expect(rows[0]).toHaveTextContent("93%");
		await expect(rows[1]).toHaveTextContent(storyProjects[0]?.name ?? "");
		await expect(rows[2]).toHaveTextContent(first?.name ?? "");
		await expect(rows[0]).toHaveAttribute("href", expect.stringMatching(/\/bots\/.+\/computer$/));
		await expect(rows[1]).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/projects/${storyProjects[0]?.slug ?? ""}/computer$`)),
		);
	},
});
