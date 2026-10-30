import type { ConnectionAccess, ConnectionTool, ConnectionUpdate } from "@sugabots/contracts";
import { listedConnection, type TestConnection } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, connectionHandlers, StoryApp, storyPods } from "../story-app.tsx";

/*
 * One connection on its own page under its pod: who connected it and what keeps
 * it working, a setting for each kind of tool, any tool set apart, and Disconnect.
 */

const API = import.meta.env.VITE_API_URL as string;

/** A connection whose tools are all at `access`. */
function connection(
	n: number,
	{
		access = "allow",
		tools = [
			{ name: "list_issues", description: "List issues", readOnly: true, destructive: false },
			{ name: "create_issue", description: "Open an issue", readOnly: false, destructive: false },
		],
		...over
	}: Partial<Omit<TestConnection, "tools">> &
		Pick<TestConnection, "name" | "handle" | "url"> & {
			access?: ConnectionAccess;
			tools?: ConnectionTool[];
		},
): TestConnection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000009${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		podId: revenue.id,
		kind: "mcp",
		auth: "header",
		signedIn: true,
		secretHeader: "Authorization",
		hasSecret: true,
		appSettingsUrl: null,
		status: "connected",
		tools: tools.map((tool) => ({ ...tool, access })),
		lastTestedAt: "2026-09-18T06:00:00.000Z",
		lastTestError: null,
		connectedBy: "Ryan Eyes",
		createdAt: "2026-09-01T00:00:00.000Z",
		...over,
	};
}

const linear = connection(1, {
	name: "Linear",
	handle: "linear",
	url: "https://mcp.linear.app/mcp",
	tools: [
		{
			name: "list_issues",
			description: "Find issues by team, state or label",
			readOnly: true,
			destructive: false,
		},
		{
			name: "get_issue",
			description: "Read one issue and its comments",
			readOnly: true,
			destructive: false,
		},
		{
			name: "create_issue",
			description: "Open an issue in a team",
			readOnly: false,
			destructive: false,
		},
		{
			name: "save_comment",
			description: "Comment on an issue",
			readOnly: false,
			destructive: false,
		},
		{
			name: "delete_issue",
			description: "Remove an issue for everyone",
			readOnly: false,
			destructive: true,
		},
	],
});
/** Linear as a pod might set it: reads run, changes ask, and deleting is off. */
const linearCustom: TestConnection = {
	...linear,
	tools: linear.tools.map((tool) => ({
		...tool,
		access: tool.destructive ? "off" : tool.readOnly ? "allow" : "ask",
	})),
};
const stripe = connection(2, {
	name: "Stripe",
	handle: "stripe",
	url: "https://mcp.stripe.com",
	status: "error",
	lastTestError:
		"The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)",
});
const notion = connection(3, {
	name: "Notion",
	handle: "notion",
	url: "https://mcp.notion.com/mcp",
	kind: "mcp",
	auth: "oauth",
	signedIn: false,
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: null,
	status: "missing_key",
	tools: [],
	lastTestedAt: null,
});
const github = connection(4, {
	name: "GitHub",
	handle: "github",
	url: "https://api.githubcopilot.com/mcp/",
	access: "ask",
	tools: Array.from({ length: 12 }, (_, index) => ({
		name: `tool_${index + 1}`,
		description: `Does thing ${index + 1}`,
		readOnly: index % 2 === 0,
		destructive: false,
	})),
});

const posthog = connection(5, {
	name: "PostHog",
	handle: "posthog",
	url: "https://mcp.posthog.com/mcp",
	tools: Array.from({ length: 300 }, (_, index) => ({
		name: `query_${index + 1}`,
		description: `Runs query ${index + 1}`,
		readOnly: true,
		destructive: false,
	})),
});

/** The pod's own GitHub App's connection: installed on acme, then waiting on its install. */
const gitHubApp = connection(6, {
	name: "GitHub",
	handle: "github-app",
	url: "https://github.com/acme",
	kind: "github",
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: "https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7",
	access: "ask",
});
const gitHubAppPending = connection(7, {
	name: "GitHub",
	handle: "github-app",
	url: "https://github.com/apps/sugabots-revenue-09a7",
	kind: "github",
	signedIn: false,
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: "https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7",
	access: "ask",
});

/** An HTTP endpoint, its method tools at their defaults. */
const alerts = connection(8, {
	name: "Alerts",
	handle: "alerts",
	url: "https://alerts.example.com/v2",
	kind: "http",
	tools: [
		{ name: "get", description: "Send a GET request.", readOnly: true, destructive: false },
		{ name: "post", description: "Send a POST request.", readOnly: false, destructive: false },
		{ name: "delete", description: "Send a DELETE request.", readOnly: false, destructive: true },
	],
	access: "ask",
});

const appRepositories = (account: string | null) =>
	http.get(`${API}/pods/:podId/connections/:connectionId/repositories`, () =>
		HttpResponse.json({
			account,
			repositories:
				account === null
					? []
					: ["acme/web", "acme/infra"].map((repository) => ({
							repository,
							addedByName: "Ryan Eyes",
							addedAt: "2026-10-05T09:30:00.000Z",
						})),
		}),
	);

const pagePath = (one: TestConnection) =>
	`/nitric/settings/pods/${revenue.slug}/connections/${one.id}`;

const meta = preview.meta({
	title: "Views/Connection",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		// Linear keeps what it is set to, as the server would.
		let current = linearCustom;
		const served = [current, stripe, notion, github, posthog, gitHubApp, gitHubAppPending, alerts];
		msw.use(
			http.patch(`${API}/pods/:podId/connections/:connectionId`, async ({ request }) => {
				const change = (await request.json()) as ConnectionUpdate;
				current = {
					...current,
					tools: current.tools.map((tool) => ({
						...tool,
						access: change.access ?? change.toolAccess?.[tool.name] ?? tool.access,
					})),
				};
				served[0] = current;
				return HttpResponse.json(listedConnection(current));
			}),
			...connectionHandlers(served),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={pagePath(linear)} />,
});

/** Opens the connection's Individual tools, as a person would. */
async function openIndividualTools() {
	await userEvent.click(
		await screen.findByRole("button", { name: /^Individual tools/ }, { timeout: 10_000 }),
	);
	await screen.findByRole("heading", { name: "Individual tools", level: 2 });
}

/**
 * A connection as a pod might set it: who connected it, what keeps it
 * working, reads allowed and changes asking first, with the one tool set
 * apart counted, and Disconnect at the foot.
 */
export const Opened = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getAllByText("Connected by Ryan Eyes")[0]).toBeInTheDocument();
		await expect(canvas.queryByText("https://mcp.linear.app/mcp")).toBeNull();
		await expect(canvas.getByRole("button", { name: "Disconnect Linear" })).toBeInTheDocument();
		const reading = await canvas.findByRole("region", { name: "Tools that read" });
		await expect(within(reading).getByRole("radio", { name: "Allowed" })).toBeChecked();
		const changes = canvas.getByRole("region", { name: "Tools that make changes" });
		await expect(within(changes).getByRole("radio", { name: "Ask first" })).toBeChecked();
		await expect(canvas.getByText("1 changed")).toBeInTheDocument();
	},
});

/** What keeps it working, in rows: its secret to replace, and Test with how it went beside it. */
export const KeepingItWorking = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Replace secret" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
	},
});

/** A whole kind at once: Allowed for changes moves every change still asking, and leaves the one set apart off. */
export const SettingAKind = meta.story({
	play: async ({ canvas }) => {
		const changes = await canvas.findByRole(
			"region",
			{ name: "Tools that make changes" },
			{ timeout: 10_000 },
		);
		await userEvent.click(within(changes).getByRole("radio", { name: "Allowed" }));
		await expect(
			await within(changes).findByRole("radio", { name: "Allowed", checked: true }),
		).toBeInTheDocument();
		await openIndividualTools();
		const changed = canvas.getByRole("region", { name: "Changed (1)" });
		await expect(
			within(within(changed).getByRole("group", { name: "delete_issue" })).getByRole("radio", {
				name: "Off",
			}),
		).toBeChecked();
	},
});

/**
 * Individual tools: the one set apart first, saying its kind's setting, then
 * the rest by kind, under a title where the connection's own was.
 */
export const IndividualTools = meta.story({
	play: async ({ canvas }) => {
		const title = await canvas.findByRole(
			"heading",
			{ name: "Linear", level: 2 },
			{ timeout: 10_000 },
		);
		const { x, y } = title.getBoundingClientRect();
		await openIndividualTools();
		const toolsTitle = canvas.getByRole("heading", { name: "Individual tools", level: 2 });
		await expect(toolsTitle.getBoundingClientRect()).toMatchObject({ x, y });
		const changed = canvas.getByRole("region", { name: "Changed (1)" });
		await expect(within(changed).getByRole("group", { name: "delete_issue" })).toBeInTheDocument();
		await expect(within(changed).getByText("Default: ask first")).toBeInTheDocument();
		await expect(within(changed).getByRole("button", { name: "Reset all" })).toBeInTheDocument();
		await expect(canvas.getByRole("region", { name: "Tools that read" })).toBeInTheDocument();
		await expect(
			canvas.getByRole("region", { name: "Tools that make changes" }),
		).toBeInTheDocument();
	},
});

/** A connection whose last check failed: why, beside Test, and a link to how to fix it. */
export const FailedCheck = meta.story({
	render: () => <StoryApp path={pagePath(stripe)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "How to fix this" }, { timeout: 10_000 }),
		).toHaveAttribute("href", "https://sugabots.ai/docs/connections#troubleshooting");
	},
});

/** Signed in through the server, but not yet: Sign in, and no tools found. */
export const NotSignedIn = meta.story({
	render: () => <StoryApp path={pagePath(notion)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Sign in" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("No actions found yet")).toBeInTheDocument();
	},
});

/** The pod's GitHub App's connection: the repositories its bots work on, from the account the app is installed on. */
export const GitHubApp = meta.story({
	beforeEach({ msw }) {
		msw.use(appRepositories("acme"));
	},
	render: () => <StoryApp path={pagePath(gitHubApp)} />,
	play: async ({ canvas }) => {
		const repositories = await canvas.findByRole(
			"region",
			{ name: "Repositories" },
			{ timeout: 10_000 },
		);
		await expect(within(repositories).getByText("acme/web")).toBeInTheDocument();
		await expect(within(repositories).getByRole("link", { name: "the pod's app" })).toHaveAttribute(
			"href",
			"https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7",
		);
		await expect(canvas.queryByRole("button", { name: "Install on GitHub" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Manage access" })).toBeInTheDocument();
	},
});

/** Add repository: what the app reaches that the connection doesn't have yet, listed as soon as it opens. */
export const AddingARepository = meta.story({
	beforeEach({ msw }) {
		msw.use(
			appRepositories("acme"),
			http.get(`${API}/pods/:podId/connections/:connectionId/github/reachable`, async () => {
				await delay(300);
				return HttpResponse.json(
					["acme/web", "acme/infra", "acme/docs"].map((repository) => ({
						repository,
						private: repository !== "acme/docs",
					})),
				);
			}),
		);
	},
	render: () => <StoryApp path={pagePath(gitHubApp)} />,
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Add repository" }, { timeout: 10_000 }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Add from acme" });
		await expect(
			await within(dialog).findByRole("button", { name: /^acme\/docs/ }, { timeout: 5_000 }),
		).toBeInTheDocument();
		await expect(within(dialog).queryByRole("button", { name: /^acme\/web/ })).toBeNull();
	},
});

/** Disconnecting GitHub says the app stays there, and links to its settings to delete it. */
export const DisconnectingGitHub = meta.story({
	beforeEach({ msw }) {
		msw.use(appRepositories("acme"));
	},
	render: () => <StoryApp path={pagePath(gitHubApp)} />,
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Disconnect GitHub" }, { timeout: 10_000 }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Disconnect GitHub?" });
		await expect(within(dialog).getByRole("link", { name: "Delete GitHub App" })).toHaveAttribute(
			"href",
			"https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7/advanced",
		);
	},
});

/** Made on GitHub but not installed yet: Install on GitHub, and no repositories until it is. */
export const GitHubAppNotInstalled = meta.story({
	beforeEach({ msw }) {
		msw.use(appRepositories(null));
	},
	render: () => <StoryApp path={pagePath(gitHubAppPending)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Install on GitHub" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Sign in" })).toBeNull();
		await expect(canvas.queryByRole("region", { name: "Repositories" })).toBeNull();
	},
});

/** Many tools: on Individual tools, a search narrows every group. */
export const SearchingTools = meta.story({
	render: () => <StoryApp path={pagePath(github)} />,
	play: async ({ canvas }) => {
		await openIndividualTools();
		await userEvent.type(canvas.getByRole("searchbox", { name: "Search tools" }), "12");
		const changes = canvas.getByRole("region", { name: "Tools that make changes" });
		await expect(within(changes).getByRole("group", { name: "tool_12" })).toBeInTheDocument();
		await expect(canvas.queryByRole("group", { name: "tool_3" })).toBeNull();
		await expect(canvas.queryByRole("region", { name: /^Reads/ })).toBeNull();
	},
});

/**
 * Hundreds of tools: they scroll inside their card, and neither the window nor
 * the settings page goes on past the card's foot.
 */
export const HundredsOfTools = meta.story({
	render: () => <StoryApp path={pagePath(posthog)} />,
	play: async ({ canvas, canvasElement }) => {
		await expect(
			await canvas.findByText("All 300 read tools", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await openIndividualTools();
		await expect(canvas.getByRole("group", { name: "query_300" })).toBeInTheDocument();
		const window = document.documentElement;
		await expect(window.scrollHeight).toBeLessThanOrEqual(window.clientHeight);
		// Rows scrolled out of the card's view add nothing below it: what the
		// settings page scrolls past the card is less than one view of the card.
		const main = canvasElement.querySelector("main");
		const card = canvas.getByRole("region", { name: "Tools" });
		if (!main) throw new Error("no settings page");
		const cardFoot =
			card.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop;
		await expect(main.scrollHeight - cardFoot).toBeLessThan(card.clientHeight);
	},
});

/** The connection's name at once, and a placeholder where its tools go while they load. */
export const LoadingTools = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/pods/:podId/connections/:connectionId`, () => delay("infinite")),
			...connectionHandlers([linearCustom]),
			...appHandlers(),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("status", { name: "Loading tools" })).toBeInTheDocument();
	},
});

/** A member who may not manage the pod's connections: everything shown, nothing to change. */
export const Member = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectionHandlers([linear]),
			...appHandlers({
				role: "member",
				pods: storyPods.map((pod) => ({
					...pod,
					permissions: { ...pod.permissions, manageConnections: false },
				})),
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("All 2 read tools")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Replace secret" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Disconnect Linear" })).toBeNull();
	},
});

/** On a phone: Back to the pod's Connections at the top. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Connections" }, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});

/** A server added by its URL, which only its address tells apart. */
export const AddedByUrl = meta.story({
	render: () => <StoryApp path={pagePath(github)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("https://api.githubcopilot.com/mcp/", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});

/** An HTTP endpoint: its address, a request per method, its secret, and Test, which sends nothing. */
export const HttpEndpoint = meta.story({
	render: () => <StoryApp path={pagePath(alerts)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("https://alerts.example.com/v2", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Replace secret" })).toBeInTheDocument();
	},
});
