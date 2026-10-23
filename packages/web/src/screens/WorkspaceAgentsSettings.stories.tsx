import type { ConnectionTool, Routine } from "@sugabots/contracts";
import type { TestConnection } from "@sugabots/contracts/testing";
import { routineTriggers, type TestRoutineTrigger } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
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
 * one's contact card. Runs on and Instructions open on pages of their own in
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
		kind: "mcp",
		auth: "header",
		signedIn: true,
		secretHeader: "Authorization",
		hasSecret: true,
		appSettingsUrl: null,
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
	trigger: TestRoutineTrigger,
	state: Routine["state"],
): Routine {
	const id = `0199a3a0-0000-7000-8000-0000000007${String(n).padStart(2, "0")}`;
	return {
		id,
		workspaceId: growthDesk.workspaceId,
		agentId: growthDesk.id,
		name,
		instructions: "Work the overnight replies and tell me what needs me.",
		triggers: routineTriggers(id, trigger),
		state,
		results: "keep_in_run",
		createdById: null,
		createdByAgentId: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	};
}

const routines: Routine[] = [
	routine(
		1,
		"Overnight outbound",
		{
			kind: "cron",
			schedule: { repeat: "cron", expression: "0 6 * * *" },
			timezone: "UTC",
			nextScheduledAt: null,
		},
		"enabled",
	),
	routine(2, "Inbound lead", { kind: "webhook", auth: { kind: "bearer" } }, "paused"),
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
 * The list of bots beside Growth Desk's contact card: its face, with the pencil
 * that changes its look, and the way to message it, about, tools and routines.
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

/** Look opens from the pencil on the bot's face: colour, shape and eyes, with Shuffle, Cancel and Save, which waits for a change. */
export const Look = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Change look" }, { timeout: 10_000 }),
		);
		const dialog = await within(document.body).findByRole("dialog", { name: "Look" });
		await expect(within(dialog).getByRole("group", { name: "Shape" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Shuffle" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
	},
});

/** The Runs on page, on a model: the switched-on models grouped by provider, the one in use checked. */
export const ModelPage = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Runs on/ }, { timeout: 10_000 }),
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
				manageSandbox: false,
			},
		})),
	});
}

/** The Runs on page for a member: the models stated, and a workspace admin named as who adds more. */
export const MemberModelPage = meta.story({
	beforeEach({ msw }) {
		msw.use(...memberHandlers());
	},
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Runs on/ }, { timeout: 10_000 }),
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

/** Growth Desk standing for an external agent, reached over A2A: no model, instructions or tools of ours. */
export const ExternalAgentCard = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				models,
				bots: bots.map((bot) =>
					bot.id === growthDesk.id
						? {
								...bot,
								a2a: {
									url: "https://agents.example.com",
									secretHeader: "Authorization",
									hasSecret: true,
									deviceId: null,
									online: null,
								},
							}
						: bot,
				),
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("button", { name: /^Runs on/ }, { timeout: 10_000 }),
		).toHaveTextContent("External agent · agents.example.com");
		await expect(canvas.getByText(/Replies come from the external agent/)).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Instructions/ })).toBeNull();
		await expect(canvas.queryByRole("heading", { name: "Tools" })).toBeNull();
	},
});

/** What the Runs on page last saved, for its story to check. */
let savedChange: unknown;

/** The Runs on page, switched to an external agent: the address its agent card is under, and the secret its service expects, saved together. */
export const ExternalAgentPage = meta.story({
	beforeEach({ msw }) {
		savedChange = undefined;
		msw.use(
			http.patch(`${API}/agents/:agentId`, async ({ request }) => {
				savedChange = await request.json();
				const change = savedChange as { a2a: { url: string; secretHeader?: string } };
				return HttpResponse.json({
					...bots.find((bot) => bot.id === growthDesk.id),
					a2a: {
						url: change.a2a.url,
						secretHeader: change.a2a.secretHeader ?? null,
						hasSecret: true,
						deviceId: null,
						online: null,
					},
				});
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Runs on/ }, { timeout: 10_000 }),
		);
		await userEvent.click(await canvas.findByRole("radio", { name: "External agent" }));
		const save = await canvas.findByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();
		await userEvent.type(canvas.getByLabelText("Address"), "https://agents.example.com");
		await userEvent.type(canvas.getByLabelText("Header name"), "Authorization");
		await userEvent.type(canvas.getByLabelText("Secret"), "Bearer s3cret");
		await userEvent.click(save);
		await waitFor(() =>
			expect(savedChange).toEqual({
				a2a: {
					url: "https://agents.example.com",
					secretHeader: "Authorization",
					secret: "Bearer s3cret",
				},
			}),
		);
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
		await expect(canvas.queryByRole("button", { name: "Change look" })).toBeNull();
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
