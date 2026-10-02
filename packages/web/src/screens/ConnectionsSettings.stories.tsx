import type { Connection, ConnectionAccess, ConnectionTool } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods } from "../story-app.tsx";

/*
 * A pod's connections, as its settings page shows them: each app its bots
 * can reach, with Allow, Ask or Off for what they may do there and what needs
 * attention; and the Add connection dialog's steps. A connection opened is
 * `Views/Connection`.
 */

const API = import.meta.env.VITE_API_URL as string;
const podPath = `/nitric/settings/pods/${revenue.slug}`;

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
	}: Partial<Omit<Connection, "tools">> &
		Pick<Connection, "name" | "handle" | "url"> & {
			access?: ConnectionAccess;
			tools?: ConnectionTool[];
		},
): Connection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000008${String(n).padStart(2, "0")}`,
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

/** One in each state the design draws: allowed, asking, off, failing its test, and not yet signed in. */
const connections: Connection[] = [
	connection(1, { name: "Linear", handle: "linear", url: "https://mcp.linear.app/mcp" }),
	{
		...connection(6, {
			name: "GitHub",
			handle: "github",
			url: "https://api.githubcopilot.com/mcp/",
		}),
		tools: [
			{
				name: "search_code",
				description: "Search code",
				readOnly: true,
				destructive: false,
				access: "allow",
			},
			{
				name: "get_file",
				description: "Read a file",
				readOnly: true,
				destructive: false,
				access: "allow",
			},
			{
				name: "create_pull_request",
				description: "Open a pull request",
				readOnly: false,
				destructive: false,
				access: "ask",
			},
			{
				name: "delete_branch",
				description: "Delete a branch",
				readOnly: false,
				destructive: true,
				access: "off",
			},
		],
	},
	connection(2, {
		name: "Sentry",
		handle: "sentry",
		url: "https://mcp.sentry.dev/mcp",
		access: "ask",
		tools: [
			{ name: "search_issues", description: "Find errors", readOnly: true, destructive: false },
		],
	}),
	connection(3, {
		name: "Team wiki",
		handle: "wiki",
		url: "https://wiki.example.com/mcp",
		access: "off",
		tools: [
			{ name: "search_pages", description: "Search pages", readOnly: true, destructive: null },
		],
	}),
	connection(4, {
		name: "Stripe",
		handle: "stripe",
		url: "https://mcp.stripe.com",
		status: "error",
		lastTestError:
			"The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)",
	}),
	connection(5, {
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
	}),
];

const meta = preview.meta({
	title: "Views/Connections",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/pods/:podId/connections`, () => HttpResponse.json(connections)),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={podPath} />,
});

/**
 * Each connection with what its tools are set to, one set tool by tool with no
 * one setting chosen, the one that failed its check, and the one waiting on a
 * sign-in.
 */
export const States = meta.story({
	play: async ({ canvas }) => {
		const github = await canvas.findByRole("article", { name: "GitHub" }, { timeout: 10_000 });
		await expect(
			within(github).getByText("Custom: 2 allowed, 1 ask first, 1 off"),
		).toBeInTheDocument();
		await expect(
			within(github).getByRole("button", { name: "GitHub, all tools: Custom" }),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Linear" })).getByRole("button", {
				name: "Linear, all tools: Allow",
			}),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Sentry" })).getByRole("button", {
				name: "Sentry, all tools: Ask",
			}),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Team wiki" })).getByRole("button", {
				name: "Team wiki, all tools: Off",
			}),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Stripe" })).getByRole("button", { name: "Fix" }),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Notion" })).getByRole("button", {
				name: "Sign in",
			}),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
	},
});

/** A row's menu: Allow, Ask or Off for every tool, or Custom to open the connection and set each. */
export const RowMenu = meta.story({
	play: async ({ canvas }) => {
		const github = await canvas.findByRole("article", { name: "GitHub" }, { timeout: 10_000 });
		await userEvent.click(
			within(github).getByRole("button", { name: "GitHub, all tools: Custom" }),
		);
		await expect(await screen.findByRole("menuitemradio", { name: "Custom" })).toBeChecked();
	},
});

/** Adding one: the apps not yet connected, searchable, and any other server by its address. */
export const AddConnection = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Add connection" }, { timeout: 10_000 }),
		);
		const dialog = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
		await expect(within(dialog).getByRole("button", { name: /^Jira/ })).toBeInTheDocument();
		await expect(within(dialog).queryByRole("button", { name: /^Linear/ })).toBeNull();
		await expect(
			within(dialog).getByRole("button", { name: /Connect by URL/ }),
		).toBeInTheDocument();
	},
});

/** An app chosen: what it reaches, and Connect, which signs in next. */
export const AddingAnApp = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Add connection" }, { timeout: 10_000 }),
		);
		const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
		await userEvent.click(within(list).getByRole("button", { name: /^Jira/ }));
		const step = await screen.findByRole("dialog", { name: "Jira" });
		await expect(within(step).getByRole("button", { name: /Connect Jira/ })).toBeInTheDocument();
	},
});

/** Any other MCP server: its name, address, an access token by default, and Test beside Add. */
export const AddingByUrl = meta.story({
	play: async ({ canvas }) => {
		const step = await openConnectByUrl(canvas);
		await expect(within(step).getByLabelText("Access token")).toBeInTheDocument();
		await expect(within(step).getByRole("button", { name: "Test" })).toBeDisabled();
		await expect(within(step).getByRole("button", { name: "Add" })).toBeDisabled();
	},
});

/** Signing in with a custom header: a header name and a secret sent exactly as typed. */
export const AddingByUrlWithHeader = meta.story({
	play: async ({ canvas }) => {
		const step = await openConnectByUrl(canvas);
		await userEvent.click(within(step).getByRole("radio", { name: "Header" }));
		await expect(within(step).getByLabelText("Header name")).toBeInTheDocument();
		await expect(within(step).queryByLabelText("Access token")).toBeNull();
	},
});

async function openConnectByUrl(canvas: ReturnType<typeof within>) {
	await userEvent.click(
		await canvas.findByRole("button", { name: "Add connection" }, { timeout: 10_000 }),
	);
	const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
	await userEvent.click(within(list).getByRole("button", { name: /Connect by URL/ }));
	return screen.findByRole("dialog", { name: "Connect by URL" });
}

/** None yet: the group holds only Add connection. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/pods/:podId/connections`, () => HttpResponse.json([])));
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Add connection" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("article")).toBeNull();
	},
});

/** A member of the pod who may not manage its connections: each one's access stated, nothing to change. */
export const Member = meta.story({
	beforeEach({ msw }) {
		msw.use(
			// Before the defaults, whose own answer here is no connections.
			http.get(`${API}/pods/:podId/connections`, () => HttpResponse.json(connections)),
			...appHandlers({
				role: "member",
				pods: storyPods.map((pod) => ({
					...pod,
					permissions: {
						...pod.permissions,
						manageConnections: false,
						rename: false,
						manageMembers: false,
					},
				})),
			}),
		);
	},
	play: async ({ canvas }) => {
		const linear = await canvas.findByRole("article", { name: "Linear" }, { timeout: 10_000 });
		await expect(within(linear).queryByRole("radio", { name: "Allow" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Add connection" })).toBeNull();
	},
});

/** On a phone: each row says what its tools are set to, and opens to change them. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		const github = await canvas.findByRole("article", { name: "GitHub" }, { timeout: 10_000 });
		await expect(within(github).getByText("Custom: 2 allowed, 1 ask first, 1 off")).toBeVisible();
		await expect(within(github).queryByRole("button", { name: /all tools/ })).toBeNull();
	},
});
