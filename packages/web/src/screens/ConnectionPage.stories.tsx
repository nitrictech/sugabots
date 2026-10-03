import type { Connection, ConnectionAccess, ConnectionTool } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods } from "../story-app.tsx";

/*
 * One connection on its own page under its pod: where it is and how it signs
 * in, its check, its tools under its access, and Remove.
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
	}: Partial<Omit<Connection, "tools">> &
		Pick<Connection, "name" | "handle" | "url"> & {
			access?: ConnectionAccess;
			tools?: ConnectionTool[];
		},
): Connection {
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
		createdAt: "2026-09-01T00:00:00.000Z",
		...over,
	};
}

const linear = connection(1, {
	name: "Linear",
	handle: "linear",
	url: "https://mcp.linear.app/mcp",
});
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

const pagePath = (one: Connection) => `/nitric/settings/pods/${revenue.slug}/connections/${one.id}`;

const meta = preview.meta({
	title: "Views/Connection",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/pods/:podId/connections`, () =>
				HttpResponse.json([linear, stripe, notion, github]),
			),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={pagePath(linear)} />,
});

/** A connection with a secret: its address, the header the secret goes in, Check, its tools, and Remove. */
export const Opened = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Linear", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByText("https://mcp.linear.app/mcp")).toBeNull();
		await expect(canvas.getByRole("heading", { name: "Runs freely" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Remove connection" })).toBeInTheDocument();
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
		await expect(canvas.getByText("No actions found yet.")).toBeInTheDocument();
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
		const asks = canvas.getByRole("region", { name: "Asks first" });
		await expect(within(asks).getByText("Does thing 12")).toBeInTheDocument();
		await expect(within(asks).queryByText("Does thing 3")).toBeNull();
	},
});

/** A member who may not manage the pod's connections: everything shown, nothing to change. */
export const Member = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/pods/:podId/connections`, () => HttpResponse.json([linear])),
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
		await expect(canvas.queryByRole("button", { name: "Replace" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Remove connection" })).toBeNull();
	},
});

/** On a phone: the page fills the screen, with Back to the pod at the top. */
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
