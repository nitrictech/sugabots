import type { ConnectionAccess, ConnectionTool, ConnectionUpdate } from "@sugabots/contracts";
import { listedConnection, type TestConnection } from "@sugabots/contracts/testing";
import { delay, HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, connectionHandlers, StoryApp, storyPods } from "../story-app.tsx";

/*
 * One connection on its own page under its pod: where it is and how it signs
 * in, its check, Allow, Ask or Off for all its tools and for each, and Remove.
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
		auth: "header",
		signedIn: true,
		secretHeader: "Authorization",
		hasSecret: true,
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
	auth: "oauth",
	signedIn: false,
	secretHeader: null,
	hasSecret: false,
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

const pagePath = (one: TestConnection) =>
	`/nitric/settings/pods/${revenue.slug}/connections/${one.id}`;

const meta = preview.meta({
	title: "Views/Connection",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		// Linear keeps what it is set to, as the server would.
		let current = linearCustom;
		const served = [current, stripe, notion, github, posthog];
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

/**
 * A connection set tool by tool: its name, Disconnect and its menu; each
 * group's menu reading Custom where its tools differ; each tool with its own
 * setting, and the one that is off faded.
 */
export const Opened = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Revenue pod connected by Ryan Eyes")).toBeInTheDocument();
		await expect(canvas.queryByText("https://mcp.linear.app/mcp")).toBeNull();
		await expect(canvas.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
		const reading = await canvas.findByRole("region", { name: "Reading" });
		await expect(
			within(reading).getByRole("button", { name: "Reading tools: Allow" }),
		).toBeInTheDocument();
		const changes = canvas.getByRole("region", { name: "Making changes" });
		await expect(
			within(changes).getByRole("button", { name: "Making changes tools: Custom" }),
		).toBeInTheDocument();
		await expect(
			within(within(changes).getByRole("group", { name: "Delete issue" })).getByRole("radio", {
				name: "Off",
			}),
		).toBeChecked();
	},
});

/** The page's menu: what keeps the connection working. */
export const ConnectionMenu = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "More for Linear" }, { timeout: 10_000 }),
		);
		await expect(
			await screen.findByRole("menuitem", { name: "Check connection" }),
		).toBeInTheDocument();
		await expect(screen.getByRole("menuitem", { name: "Replace secret" })).toBeInTheDocument();
	},
});

/** A whole group at once: choosing Allow in its menu sets each of its tools to it. */
export const SettingAGroup = meta.story({
	play: async ({ canvas }) => {
		const changes = await canvas.findByRole(
			"region",
			{ name: "Making changes" },
			{ timeout: 10_000 },
		);
		await userEvent.click(
			within(changes).getByRole("button", { name: "Making changes tools: Custom" }),
		);
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Allow" }));
		await expect(
			await within(within(changes).getByRole("group", { name: "Delete issue" })).findByRole(
				"radio",
				{ name: "Allow", checked: true },
			),
		).toBeInTheDocument();
		await expect(
			await within(changes).findByRole("button", { name: "Making changes tools: Allow" }),
		).toBeInTheDocument();
	},
});

/** A connection whose last check failed: why, and a link to how to fix it. */
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
		await expect(await canvas.findByText("No actions found yet.")).toBeInTheDocument();
	},
});

/** Many tools: a search narrows them. */
export const SearchingTools = meta.story({
	render: () => <StoryApp path={pagePath(github)} />,
	play: async ({ canvas }) => {
		const search = await canvas.findByRole(
			"searchbox",
			{ name: "Search tools" },
			{ timeout: 10_000 },
		);
		await userEvent.type(search, "12");
		const changes = canvas.getByRole("region", { name: "Making changes" });
		await expect(within(changes).getByRole("group", { name: "Tool 12" })).toBeInTheDocument();
		await expect(canvas.queryByRole("group", { name: "Tool 3" })).toBeNull();
		await expect(canvas.queryByRole("region", { name: "Reading" })).toBeNull();
	},
});

/** Hundreds of tools: they scroll inside the settings panel, and the window itself never scrolls. */
export const HundredsOfTools = meta.story({
	render: () => <StoryApp path={pagePath(posthog)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("group", { name: "Query 300" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		const page = document.documentElement;
		await expect(page.scrollHeight).toBeLessThanOrEqual(page.clientHeight);
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
		await expect(canvas.queryByRole("radio")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Replace" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Disconnect" })).toBeNull();
	},
});

/** On a phone: Back to the pod at the top, and each tool with its setting beside it. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: revenue.name }, { timeout: 10_000 }),
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
