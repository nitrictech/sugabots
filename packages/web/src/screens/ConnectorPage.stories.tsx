import type { ConnectorUpdate } from "@sugabots/contracts";
import { listedConnector, type TestConnector } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	connectorHandlers,
	StoryApp,
	storyProjects,
} from "../story-app.test-support.tsx";
import { storyConnector } from "./connector-story.test-support.ts";

/*
 * One connector on its own page under its project: who connected it and what
 * keeps it working, a setting for each kind of tool, any tool set apart, and Disconnect.
 */

const API = import.meta.env.VITE_API_URL as string;

const linear = storyConnector("0901", {
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
/** Linear as a bot might set it: reads run, changes ask, and deleting is off. */
const linearCustom: TestConnector = {
	...linear,
	tools: linear.tools.map((tool) => ({
		...tool,
		access: tool.destructive ? "off" : tool.readOnly ? "allow" : "ask",
	})),
};
const stripe = storyConnector("0902", {
	name: "Stripe",
	handle: "stripe",
	url: "https://mcp.stripe.com",
	status: "error",
	lastTestError:
		"The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)",
});
const notion = storyConnector("0903", {
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
});
const asana = storyConnector("0909", {
	name: "Asana",
	handle: "asana",
	url: "https://mcp.asana.com/sse",
	auth: "oauth",
	signedIn: false,
	signInExpired: true,
	secretHeader: null,
	hasSecret: false,
});
const github = storyConnector("0904", {
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

const posthog = storyConnector("0905", {
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

/** The project's own GitHub app's connector: installed on acme, then waiting on its install. */
const gitHubApp = storyConnector("0906", {
	name: "GitHub",
	handle: "github-app",
	url: "https://github.com/acme",
	kind: "github",
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: "https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7",
	access: "ask",
});
const gitHubAppPending = storyConnector("0907", {
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
const alerts = storyConnector("0908", {
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
	http.get(`${API}/projects/:projectId/connectors/:connectorId/repositories`, () =>
		HttpResponse.json({
			account,
			repositories:
				account === null
					? []
					: ["web", "infra"].map((repository) => ({
							repository: `${account}/${repository}`,
							addedByName: "Rowan Ellis",
						})),
		}),
	);

const pagePath = (one: TestConnector) => `/nitric/projects/${revenue.slug}/connectors/${one.id}`;

const meta = preview.meta({
	title: "Views/Connector",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		// Linear keeps what it is set to, as the server would.
		let current = linearCustom;
		const served = [
			current,
			stripe,
			notion,
			asana,
			github,
			posthog,
			gitHubApp,
			gitHubAppPending,
			alerts,
		];
		msw.use(
			http.patch(`${API}/projects/:projectId/connectors/:connectorId`, async ({ request }) => {
				const { changes: change } = (await request.json()) as { changes: ConnectorUpdate };
				current = {
					...current,
					tools: current.tools.map((tool) => ({
						...tool,
						access: change.access ?? change.toolAccess?.[tool.name] ?? tool.access,
					})),
				};
				served[0] = current;
				return HttpResponse.json(listedConnector(current));
			}),
			...connectorHandlers(served),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={pagePath(linear)} />,
});

/** Opens the connector's Individual tools, as a member would. */
async function openIndividualTools() {
	await userEvent.click(await screen.findByRole("button", { name: /^Individual tools/ }));
	await screen.findByRole("heading", { name: "Individual tools", level: 2 });
}

/**
 * A connector as a bot might set it: who connected it, what keeps it
 * working, reads allowed and changes asking first, with the one tool set
 * apart counted, and Disconnect at the foot.
 */
export const Opened = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 1 }),
		).toBeInTheDocument();
		await expect(canvas.getAllByText("Connected by Rowan Ellis")[0]).toBeInTheDocument();
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
		await expect(await canvas.findByRole("button", { name: "Replace secret" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Test connector" })).toBeInTheDocument();
	},
});

/** A whole kind at once: Allowed for changes moves every change still asking, and leaves the one set apart off. */
export const SettingAKind = meta.story({
	play: async ({ canvas }) => {
		const changes = await canvas.findByRole("region", { name: "Tools that make changes" });
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
 * the rest by kind, with Back to the connector.
 */
export const IndividualTools = meta.story({
	play: async ({ canvas }) => {
		await canvas.findByRole("heading", { name: "Linear", level: 1 });
		await openIndividualTools();
		await expect(canvas.getByRole("button", { name: "Linear" })).toBeInTheDocument();
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

/** A connector whose last check failed: why, beside Test, and a link to how to fix it. */
export const FailedCheck = meta.story({
	render: () => <StoryApp path={pagePath(stripe)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "How to fix this" })).toHaveAttribute(
			"href",
			"https://sugabots.ai/docs/connectors#troubleshooting",
		);
	},
});

/** Signed in through the server, but not yet: Sign in, and no tools found. */
export const NotSignedIn = meta.story({
	render: () => <StoryApp path={pagePath(notion)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
		await expect(await canvas.findByText("No tools found yet")).toBeInTheDocument();
	},
});

/** A project's GitHub App connector: the repositories its bots work on, from the account the app is installed on. */
export const GitHubApp = meta.story({
	beforeEach({ msw }) {
		msw.use(appRepositories("acme"));
	},
	render: () => <StoryApp path={pagePath(gitHubApp)} />,
	play: async ({ canvas }) => {
		const repositories = await canvas.findByRole("region", { name: "Repositories" });
		await expect(within(repositories).getByText("acme/web")).toBeInTheDocument();
		await expect(
			within(repositories).getByRole("link", { name: "the project's app" }),
		).toHaveAttribute(
			"href",
			"https://github.com/organizations/acme/settings/apps/sugabots-revenue-09a7",
		);
		const account = canvas.getByRole("region", { name: "Account" });
		await expect(within(account).getByText("Installed by")).toBeVisible();
		await expect(within(account).getByText("Rowan Ellis")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Install on GitHub" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Manage access" })).toBeInTheDocument();
	},
});

/** GitHubAppInstalledByAnotherMember shows who installed the app on their own GitHub account. */
export const GitHubAppInstalledByAnotherMember = meta.story({
	name: "GitHub app installed by another member",
	beforeEach({ msw }) {
		msw.use(
			appRepositories("jaypark"),
			...connectorHandlers([
				{
					...gitHubApp,
					url: "https://github.com/jaypark",
					signedInAs: {
						id: "0199a3a0-0000-7000-8000-00000000000a",
						name: "Jay Park",
						email: "jay@example.com",
						image: null,
					},
				},
			]),
		);
	},
	render: () => <StoryApp path={pagePath(gitHubApp)} />,
	play: async ({ canvas }) => {
		const account = within(await canvas.findByRole("region", { name: "Account" }));
		await expect(account.getByText("Installed by")).toBeVisible();
		await expect(account.getByText("Jay Park")).toBeVisible();
		await expect(account.queryByText("Rowan Ellis")).toBeNull();
	},
});

/** Add repository: what the app reaches that the connector doesn't have yet, listed as soon as it opens. */
export const AddingARepository = meta.story({
	beforeEach({ msw }) {
		msw.use(
			appRepositories("acme"),
			http.get(`${API}/projects/:projectId/connectors/:connectorId/github/reachable`, async () => {
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
		await userEvent.click(await canvas.findByRole("button", { name: "Add repository" }));
		const dialog = await screen.findByRole("dialog", { name: "Add from acme" });
		await expect(
			await within(dialog).findByRole("button", { name: /^acme\/docs/ }),
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
		await userEvent.click(await canvas.findByRole("button", { name: "Disconnect GitHub" }));
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
			await canvas.findByRole("button", { name: "Install on GitHub" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Sign in" })).toBeNull();
		await expect(canvas.queryByRole("region", { name: "Repositories" })).toBeNull();
	},
});

/** A sign-in the server refused during a turn: Sign in again, and the tools it listed before. */
export const SignInExpired = meta.story({
	render: () => <StoryApp path={pagePath(asana)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("Sign-in expired", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
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
		await expect(await canvas.findByText("All 300 read tools")).toBeInTheDocument();
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

/** The connector's name at once, and a placeholder where its tools go while they load. */
export const LoadingTools = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/projects/:projectId/connectors/:connectorId`, () => delay("infinite")),
			...connectorHandlers([linearCustom]),
			...appHandlers(),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 1 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("status", { name: "Loading tools" })).toBeInTheDocument();
	},
});

/** An editor, who may not manage the project's connectors: everything shown, nothing to change. */
export const Editor = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectorHandlers([linear]),
			...appHandlers({
				role: "editor",
				projects: storyProjects.map((project) => ({
					...project,
					permissions: {
						...project.permissions,
						resources: { ...project.permissions.resources, manageConnectors: false },
					},
				})),
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 1 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("All 2 read tools")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Replace secret" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Disconnect Linear" })).toBeNull();
	},
});

/** On a phone: the header's own Back at the top, and no second one under it. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Linear", level: 1 })).toBeVisible();
		const backLinks = await canvas.findAllByRole("link", { name: /^Back/ });
		await expect(backLinks).toHaveLength(1);
		await expect(backLinks[0]).toBeVisible();
	},
});

/** A server added by its URL, which only its address tells apart. */
export const AddedByUrl = meta.story({
	render: () => <StoryApp path={pagePath(github)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("https://api.githubcopilot.com/mcp/")).toBeInTheDocument();
	},
});

/** An HTTP endpoint: its address, a request per method, its secret, and Test, which sends nothing. */
export const HttpEndpoint = meta.story({
	render: () => <StoryApp path={pagePath(alerts)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("https://alerts.example.com/v2")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Test connector" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Replace secret" })).toBeInTheDocument();
	},
});
