import type { Automation, ConnectionTool } from "@sugabots/contracts";
import type { TestConnection } from "@sugabots/contracts/testing";
import { automationTriggers, type TestAutomationTrigger } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, connectionHandlers, StoryApp, storyBots, storyModel } from "../story-app.tsx";

/*
 * A bot's settings, opened from Bots: its contact card, with its profile,
 * model and instructions edited in place, its tools, connections and
 * automations, and on a phone Back to the list.
 *
 * Handlers a story adds with `msw.use` are tried before the meta's, so each
 * story answers only what it is about.
 */

const API = import.meta.env.VITE_API_URL as string;
const cardPath = `/nitric/settings/bots/${growthDesk.handle}`;

/** The workspace's switched-on models across three providers, to choose the bot's model from. */
const models = [
	storyModel,
	{ ...storyModel, modelId: "claude-opus-4-1", displayName: "Claude Opus" },
	{
		...storyModel,
		providerId: "0199a3a0-0000-7000-8000-000000000202",
		providerName: "OpenAI",
		providerPreset: "openai",
		modelId: "gpt-5",
		displayName: "GPT-5",
	},
	{
		...storyModel,
		providerId: "0199a3a0-0000-7000-8000-000000000203",
		providerName: "Ollama",
		providerPreset: "ollama",
		modelId: "qwen3.5:4b",
		displayName: "Qwen 3.5 4B",
	},
];

/** Growth Desk with a description and instructions, so its card and Instructions page have words. */
const bots = storyBots.map((bot) =>
	bot.id === growthDesk.id
		? {
				...bot,
				description: "Runs outbound, watches replies and keeps the pipeline moving.",
				prompt:
					"Work the Revenue pipeline. Draft replies in the rep's voice, keep them short, and never send without asking.",
			}
		: bot,
);

function connection(
	n: number,
	name: string,
	handle: string,
	url: string,
	tools: ConnectionTool[],
): TestConnection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000006${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		projectId: growthDesk.defaultProjectId,
		name,
		handle,
		url,
		kind: "mcp",
		auth: "header",
		signedIn: true,
		signInExpired: false,
		secretHeader: "Authorization",
		hasSecret: true,
		appSettingsUrl: null,
		status: "connected",
		tools: tools.map((tool) => ({ ...tool, access: "allow" as const })),
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const projectTools: TestConnection[] = [
	connection(1, "HubSpot", "hubspot", "https://mcp.hubspot.com/mcp", [
		{ name: "search_contacts", description: "Find contacts", readOnly: true, destructive: false },
		{ name: "update_deal", description: "Change a deal", readOnly: false, destructive: false },
	]),
	connection(2, "Gmail", "gmail", "https://gmail.mcp.example.com/mcp", [
		{ name: "read_inbox", description: "Read email", readOnly: true, destructive: false },
		{ name: "send_email", description: "Send an email", readOnly: false, destructive: false },
	]),
];

function automation(
	n: number,
	name: string,
	trigger: TestAutomationTrigger,
	state: Automation["state"],
): Automation {
	const id = `0199a3a0-0000-7000-8000-0000000007${String(n).padStart(2, "0")}`;
	return {
		id,
		workspaceId: growthDesk.workspaceId,
		projectId: growthDesk.defaultProjectId,
		name,
		instructions: "Work the overnight replies and tell me what needs me.",
		triggers: automationTriggers(id, trigger),
		state,
		createdById: null,
		pausedAfterFailures: false,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	};
}

const automations: Automation[] = [
	automation(
		1,
		"Overnight outbound",
		{
			kind: "routine",
			schedule: { repeat: "cron", expression: "0 6 * * *" },
			timezone: "UTC",
			nextScheduledAt: null,
		},
		"enabled",
	),
	automation(2, "Inbound lead", { kind: "webhook", auth: { kind: "bearer" } }, "paused"),
];

const meta = preview.meta({
	title: "Views/Bots",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ models, bots }));
	},
	render: () => <StoryApp path={cardPath} />,
});

/**
 * Growth Desk's contact card, a page of its own in Bots: its
 * face, with the pencil that changes its look, and the way to message it,
 * about, tools and automations.
 */
export const ContactCard = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		const trail = canvas.getByRole("navigation", { name: "Breadcrumb" });
		await expect(within(trail).getByRole("link", { name: "Bots" })).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Built-in tools" })).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
		await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(growthDesk.name);
		await expect(canvas.getByRole("textbox", { name: "Description" })).toBeInTheDocument();
		// No computers are set up for the workspace, so the bot's is off and can't be turned on.
		await waitFor(() =>
			expect(canvas.getByRole("switch", { name: "Turn on Computer" })).toBeDisabled(),
		);
		const computer = canvas.getByRole("switch", { name: "Turn on Computer" });
		await expect(computer).toHaveAttribute("aria-checked", "false");
		await userEvent.hover(computer);
		// Said under its name, and again by the switch when pointed at.
		await waitFor(() => expect(screen.getAllByText(/^Computers are off for /)).toHaveLength(2));
	},
});

/**
 * The look, opened by clicking the bot's face: the bot on a faint tint of its
 * colour, its shape, eyes and colour beside it, and Save, which waits for a
 * change.
 */
export const Look = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Change look" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `${growthDesk.name}'s look`,
		});
		await expect(within(dialog).getByRole("tab", { name: "Shape" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("group", { name: "Colour" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
	},
});

/** The model, chosen in its profile from the models switched on for the workspace, each by its provider, the one in use checked. */
export const ModelPage = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Model: Claude Sonnet" }));
		const menu = await screen.findByRole("menu");
		await expect(within(menu).getByRole("menuitemradio", { name: /^GPT-5/ })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expect(
			within(menu).getByRole("menuitemradio", { name: /^Claude Sonnet/ }),
		).toHaveAttribute("aria-checked", "true");
		await expect(within(menu).getByText("OpenAI")).toBeInTheDocument();
	},
});

/** A member of the workspace who may not change the bot. */
function memberHandlers() {
	return appHandlers({
		models,
		bots: bots.map((bot) => ({
			...bot,
			permissions: {
				...bot.permissions,
				update: false,
				delete: false,
				resources: {
					...bot.permissions.resources,
					manageAutomations: false,
					manageConnections: false,
					manageComputer: false,
				},
			},
		})),
		role: "member",
	});
}

/** The model for a member: stated, not a menu to choose from. */
export const MemberModelPage = meta.story({
	beforeEach({ msw }) {
		msw.use(...memberHandlers());
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: "Model: Claude Sonnet" }),
		).toBeDisabled();
	},
});

/** The bot's instructions, on its card, counted against their limit. */
export const InstructionsPage = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("textbox", { name: "Instructions" })).toBeInTheDocument();
		await expect(canvas.getByText(/of 20,000 characters/)).toBeInTheDocument();
	},
});

/** A bot with its connections, each with how many tools it can use, and its two automations counted, with the way to its Automations page. */
export const ToolsAndAutomations = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectionHandlers(projectTools),
			http.get(`${API}/projects/:projectId/automations`, () => HttpResponse.json(automations)),
		);
	},
	play: async ({ canvas }) => {
		const connections = await canvas.findByRole("region", { name: "Connections" });
		await expect(await within(connections).findByText("HubSpot")).toBeInTheDocument();
		await expect(within(connections).getAllByText("2 tools")).not.toHaveLength(0);
		await expect(within(connections).queryByRole("switch")).toBeNull();
		const automationsRow = canvas.getByRole("link", { name: /^Automations/ });
		await waitFor(() => expect(within(automationsRow).getByText("2")).toBeInTheDocument());
		await expect(automationsRow).toHaveAttribute(
			"href",
			`/nitric/bots/${growthDesk.handle}/automations`,
		);
	},
});

/** A member who may not change the bot: its settings stated rather than editable. */
export const Member = meta.story({
	beforeEach({ msw }) {
		msw.use(...memberHandlers());
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete bot" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Change look" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New bot" })).toBeNull();
	},
});

/** On a phone the card covers the list, with the way back to it. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("main")).getByRole("link", { name: "Bots" }),
		).toBeInTheDocument();
	},
});
