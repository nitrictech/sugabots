import type { ConnectionTool, Routine } from "@sugabots/contracts";
import type { TestConnection } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	connectionHandlers,
	StoryApp,
	storyBots,
	storyModel,
	storyPods,
} from "../story-app.tsx";

/*
 * Bots in settings: every bot, each under its pod's name, beside the open
 * one's contact card. Model and Instructions open on pages of their own in
 * the same place; on a phone the card covers the list, with Back to it.
 *
 * Handlers a story adds with `msw.use` are tried before the meta's, so each
 * story answers only what it is about.
 */

const API = import.meta.env.VITE_API_URL as string;
const cardPath = `/nitric/settings/pods/${revenue.slug}/agents/${growthDesk.handle}`;

/** The workspace's switched-on models across three providers, so the Model page groups them. */
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
		podId: revenue.id,
		name,
		handle,
		url,
		auth: "header",
		signedIn: true,
		secretHeader: "Authorization",
		hasSecret: true,
		status: "connected",
		tools: tools.map((tool) => ({ ...tool, access: "allow" as const })),
		lastTestedAt: "2026-09-18T06:00:00.000Z",
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const podTools: TestConnection[] = [
	connection(1, "HubSpot", "hubspot", "https://mcp.hubspot.com/mcp", [
		{ name: "search_contacts", description: "Find contacts", readOnly: true, destructive: false },
		{ name: "update_deal", description: "Change a deal", readOnly: false, destructive: false },
	]),
	connection(2, "Gmail", "gmail", "https://gmail.mcp.example.com/mcp", [
		{ name: "read_inbox", description: "Read email", readOnly: true, destructive: false },
		{ name: "send_email", description: "Send an email", readOnly: false, destructive: false },
	]),
];

function routine(
	n: number,
	name: string,
	trigger: Routine["trigger"],
	state: Routine["state"],
): Routine {
	return {
		id: `0199a3a0-0000-7000-8000-0000000007${String(n).padStart(2, "0")}`,
		workspaceId: growthDesk.workspaceId,
		agentId: growthDesk.id,
		name,
		instructions: "Work the overnight replies and tell me what needs me.",
		trigger,
		state,
		createdById: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	};
}

const routines: Routine[] = [
	routine(
		1,
		"Overnight outbound",
		{ kind: "cron", expression: "0 6 * * *", timezone: "UTC", nextScheduledAt: null },
		"enabled",
	),
	routine(2, "Inbound lead", { kind: "webhook" }, "paused"),
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
 * The list of bots beside Growth Desk's contact card: its face with the way to
 * message it, about, look, tools and routines.
 */
export const ContactCard = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: growthDesk.name }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("navigation", { name: "Workspace bots" })).toBeInTheDocument();
		await expect(canvas.getByRole("link", { name: "Message" })).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/agents/${growthDesk.handle}$`)),
		);
		await expect(canvas.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
	},
});

/** The Model page: the switched-on models grouped by provider, the one in use checked. */
export const ModelPage = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Model/ }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("heading", { name: "OpenAI" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "GPT-5" })).toBeInTheDocument();
		// The model in use is checked, with nothing to press.
		await expect(canvas.queryByRole("button", { name: "Claude Sonnet" })).toBeNull();
		await expect(
			within(canvas.getByRole("main")).getByRole("link", { name: "Models" }),
		).toHaveAttribute("href", "/nitric/settings/providers");
	},
});

/** A member of the workspace who may not change its bots or its models. */
function memberHandlers() {
	return appHandlers({
		models,
		bots,
		role: "member",
		pods: storyPods.map((pod) => ({
			...pod,
			permissions: {
				...pod.permissions,
				createAgents: false,
				updateAgents: false,
				deleteAgents: false,
				manageRoutines: false,
				manageConnections: false,
			},
		})),
	});
}

/** The Model page for a member: the models stated, and a workspace admin named as who adds more. */
export const MemberModelPage = meta.story({
	beforeEach({ msw }) {
		msw.use(...memberHandlers());
	},
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Model/ }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByText(/ask a workspace admin/)).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("main")).queryByRole("link", { name: "Models" }),
		).toBeNull();
	},
});

/** The Instructions page: the bot's instructions, counted against their limit. */
export const InstructionsPage = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Instructions/ }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByLabelText("Instructions")).toBeInTheDocument();
		await expect(canvas.getByText(/of 20,000 characters/)).toBeInTheDocument();
	},
});

/** A bot with its pod's connections, and two routines: one on a schedule, one paused webhook. */
export const ToolsAndRoutines = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectionHandlers(podTools),
			http.get(`${API}/agents/:agentId/routines`, () => HttpResponse.json(routines)),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: /HubSpot/ }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("Overnight outbound")).toBeInTheDocument();
		await expect(canvas.getByText("Inbound lead")).toBeInTheDocument();
	},
});

/** A member who may not change the bot: its settings stated rather than editable. */
export const Member = meta.story({
	beforeEach({ msw }) {
		msw.use(...memberHandlers());
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: growthDesk.name }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete bot" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New bot" })).toBeNull();
	},
});

/** On a phone the card covers the list, with the way back to it. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: growthDesk.name }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(
			within(canvas.getByRole("main")).getByRole("link", { name: "Bots" }),
		).toBeInTheDocument();
	},
});
