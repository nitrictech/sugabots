import type { ProjectBotConnector } from "@sugabots/contracts";
import type { TestConnector } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { accountManager, growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	connectorHandlers,
	StoryApp,
	storyProjects,
} from "../story-app.test-support.tsx";
import { storyConnector } from "./connector-story.test-support.ts";

/*
 * A project's connectors, as its Connectors page shows them: each service its bots
 * can reach, with Allow, Ask or Off for what they may do there and what needs
 * attention; and the Add connector dialog's steps. A connector opened is
 * `Views/Connector`.
 */

const API = import.meta.env.VITE_API_URL as string;
const projectPath = `/nitric/projects/${revenue.slug}/connectors`;

/** One in each state the design draws: allowed, asking, off, failing its test, and not yet signed in. */
const connectors: TestConnector[] = [
	storyConnector("0801", {
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		auth: "oauth",
		secretHeader: null,
		hasSecret: false,
		signedInAs: {
			id: "0199a3a0-0000-7000-8000-000000000009",
			name: "Rowan Alexandria Ellis",
			email: "rowan@example.com",
			image: null,
		},
	}),
	{
		...storyConnector("0806", {
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
	storyConnector("0802", {
		name: "Sentry",
		handle: "sentry",
		url: "https://mcp.sentry.dev/mcp",
		access: "ask",
		tools: [
			{ name: "search_issues", description: "Find errors", readOnly: true, destructive: false },
		],
	}),
	storyConnector("0803", {
		name: "Team wiki",
		handle: "wiki",
		url: "https://wiki.example.com/mcp",
		access: "off",
		tools: [
			{ name: "search_pages", description: "Search pages", readOnly: true, destructive: null },
		],
	}),
	storyConnector("0804", {
		name: "Stripe",
		handle: "stripe",
		url: "https://mcp.stripe.com",
		status: "error",
		lastTestError:
			"The server didn't accept the access token or secret. Check that it hasn't expired and was copied in full (HTTP 401)",
	}),
	storyConnector("0805", {
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
	}),
	storyConnector("0806", {
		name: "Asana",
		handle: "asana",
		url: "https://mcp.asana.com/sse",
		auth: "oauth",
		signedIn: false,
		signInExpired: true,
		secretHeader: null,
		hasSecret: false,
	}),
];

const meta = preview.meta({
	title: "Views/Connectors",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...connectorHandlers(connectors), ...appHandlers());
	},
	render: () => <StoryApp path={projectPath} />,
});

/**
 * Each connector with what its tools are set to, one set tool by tool with no
 * one setting chosen, the one that failed its check, the one waiting on a
 * sign-in, and the one whose sign-in expired.
 */
export const States = meta.story({
	play: async ({ canvas }) => {
		const github = await canvas.findByRole("article", { name: "GitHub" });
		await expect(
			within(github).getByText("Custom: 2 allowed, 1 ask first, 1 off"),
		).toBeInTheDocument();
		// What its tools may do is said, and set inside the connector, not here.
		await expect(within(github).queryByRole("button")).toBeNull();
		const linear = canvas.getByRole("article", { name: "Linear" });
		await expect(within(linear).getByText("Every tool runs without asking")).toBeInTheDocument();
		await expect(
			within(linear).getByText("Signed in as Rowan Alexandria Ellis"),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Sentry" })).getByText("Every tool asks first"),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Team wiki" })).getByText("Off for every bot"),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Stripe" })).getByRole("button", { name: "Fix" }),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("article", { name: "Notion" })).getByRole("button", {
				name: "Sign in",
			}),
		).toBeInTheDocument();
		const asana = canvas.getByRole("article", { name: "Asana" });
		await expect(within(asana).getByText(/^Sign-in expired/)).toBeInTheDocument();
		await expect(within(asana).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Add connector" })).toBeInTheDocument();
	},
});

/** Adding one: the apps not yet connected, searchable, and any other server by its address. */
export const AddConnector = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Add connector" }));
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
		await userEvent.click(await canvas.findByRole("button", { name: "Add connector" }));
		const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
		await userEvent.click(within(list).getByRole("button", { name: /^Jira/ }));
		const step = await screen.findByRole("dialog", { name: "Jira" });
		await expect(within(step).getByRole("button", { name: /Connect Jira/ })).toBeInTheDocument();
	},
});

/** GitHub chosen: the project gets an app of its own, made on GitHub for the organization named or the member. */
export const AddingGitHub = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Add connector" }));
		const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
		await expect(within(list).queryByText("Code")).toBeNull();
		await userEvent.type(
			within(list).getByRole("searchbox", { name: "Search connectors" }),
			"pull",
		);
		await userEvent.click(within(list).getByRole("button", { name: /^GitHub/ }));
		const step = await screen.findByRole("dialog", { name: "GitHub" });
		await expect(within(step).getByLabelText("Organization")).toHaveValue("");
		await expect(within(step).getByRole("button", { name: "Make on GitHub" })).toBeEnabled();
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

/** An HTTP endpoint: its base address, and a token, a header or neither; nothing to test before adding. */
export const AddingAnHttpEndpoint = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Add connector" }));
		const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
		await userEvent.click(within(list).getByRole("button", { name: /HTTP endpoint/ }));
		const step = await screen.findByRole("dialog", { name: "HTTP endpoint" });
		await expect(within(step).getByLabelText("Access token")).toBeInTheDocument();
		await expect(within(step).queryByRole("radio", { name: "Sign in" })).toBeNull();
		await expect(within(step).queryByRole("button", { name: "Test" })).toBeNull();
	},
});

async function openConnectByUrl(canvas: ReturnType<typeof within>) {
	await userEvent.click(await canvas.findByRole("button", { name: "Add connector" }));
	const list = await screen.findByRole("dialog", { name: `Add to ${revenue.name}` });
	await userEvent.click(within(list).getByRole("button", { name: /Connect by URL/ }));
	return screen.findByRole("dialog", { name: "Connect by URL" });
}

/** None yet: the group holds only Add connector. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/projects/:projectId/connectors`, () => HttpResponse.json([])));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Add connector" })).toBeInTheDocument();
		await expect(canvas.queryByRole("article")).toBeNull();
	},
});

/** An editor, who may not manage the project's connectors: each one's access stated, nothing to change. */
export const Editor = meta.story({
	beforeEach({ msw }) {
		msw.use(
			// Before the defaults, whose own answer here is no connectors.
			...connectorHandlers(connectors),
			...appHandlers({
				role: "editor",
				projects: storyProjects.map((project) => ({
					...project,
					permissions: {
						...project.permissions,
						rename: false,
						manageMembers: false,
						resources: {
							...project.permissions.resources,
							manageConnectors: false,
							manageComputer: false,
						},
					},
				})),
			}),
		);
	},
	play: async ({ canvas }) => {
		const linear = await canvas.findByRole("article", { name: "Linear" });
		await expect(within(linear).queryByRole("radio", { name: "Allow" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Add connector" })).toBeNull();
	},
});

/** On a phone: each row says what its tools are set to, and opens to change them. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		const github = await canvas.findByRole("article", { name: "GitHub" });
		await expect(within(github).getByText("Custom: 2 allowed, 1 ask first, 1 off")).toBeVisible();
		await expect(within(github).queryByRole("button", { name: /all tools/ })).toBeNull();
	},
});

/** Revenue's bots' own connectors: one on here, one off, and one whose address changed since it was turned on. */
const botsOwn: ProjectBotConnector[] = [
	{
		id: "0199a3a0-0000-7000-8000-000000000901",
		name: "Notion",
		kind: "mcp",
		url: "https://mcp.notion.com/mcp",
		botId: growthDesk.id,
		botName: growthDesk.name,
		on: true,
		addressChanged: false,
	},
	{
		id: "0199a3a0-0000-7000-8000-000000000902",
		name: "Billing API",
		kind: "http",
		url: "https://billing.example.com/v1",
		botId: growthDesk.id,
		botName: growthDesk.name,
		on: false,
		addressChanged: false,
	},
	{
		id: "0199a3a0-0000-7000-8000-000000000903",
		name: "CRM",
		kind: "http",
		url: "https://crm.example.com/api",
		botId: accountManager.id,
		botName: accountManager.name,
		on: false,
		addressChanged: true,
	},
];

/**
 * The project's bots' own connectors, each off here until a manager turns it
 * on: one bot's row says how many are on and opens to list them, each with
 * where it sends data and a switch.
 */
export const BotsOwnConnectors = meta.story({
	beforeEach({ msw }) {
		let rows = botsOwn;
		msw.use(
			http.get(`${API}/projects/:projectId/bot-connectors`, () => HttpResponse.json(rows)),
			http.put(
				`${API}/projects/:projectId/bot-connectors/:connectorId`,
				async ({ params, request }) => {
					const { on } = (await request.json()) as { on: boolean };
					rows = rows.map((row) =>
						row.id === params.connectorId ? { ...row, on, addressChanged: false } : row,
					);
					return HttpResponse.json(rows.find((row) => row.id === params.connectorId));
				},
			),
		);
	},
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: /Growth Desk/ }));
		await expect(canvas.getByText("1 of 2 on here")).toBeInTheDocument();
		const billing = await canvas.findByRole("switch", { name: `Billing API in ${revenue.name}` });
		await expect(billing).toHaveAttribute("aria-checked", "false");
		await userEvent.click(billing);
		await expect(
			await canvas.findByRole("switch", { name: `Billing API in ${revenue.name}`, checked: true }),
		).toBeInTheDocument();
	},
});

/** A bot's connector whose address changed since it was turned on, which turned it off. */
export const BotsOwnConnectorMoved = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/projects/:projectId/bot-connectors`, () => HttpResponse.json(botsOwn)),
		);
	},
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: /Account Manager/ }));
		await expect(
			await canvas.findByText("Its address changed, so it is off until someone turns it on again"),
		).toBeInTheDocument();
	},
});
