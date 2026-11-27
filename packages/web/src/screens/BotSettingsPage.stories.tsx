import type { Automation, ConnectorTool } from "@sugabots/contracts";
import type { TestConnector } from "@sugabots/contracts/testing";
import { automationTriggers, type TestAutomationTrigger } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue, storyBots } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	connectorHandlers,
	StoryApp,
	storyMember,
	storyModel,
} from "../story-app.test-support.tsx";
import { personalBot } from "./BotRestrictions.test-support.ts";

/*
 * A bot's settings, a page of its own beside its chats: its contact card,
 * with its profile, model and instructions edited in place, its tools,
 * connectors and automations, and on a phone Back to the bot.
 *
 * Handlers a story adds with `msw.use` are tried before the meta's, so each
 * story answers only what it is about.
 */

const API = import.meta.env.VITE_API_URL as string;
const cardPath = `/nitric/bots/${growthDesk.handle}/settings`;

/** The workspace's switched-on models across three providers, to choose the bot's model from. */
const models = [
	storyModel,
	{ ...storyModel, modelId: "claude-opus-4-1", displayName: "Claude Opus" },
	{
		...storyModel,
		providerId: "0199a3a0-0000-7000-8000-000000000202",
		providerName: "OpenAI",
		providerBuiltIn: "openai",
		modelId: "gpt-5",
		displayName: "GPT-5",
	},
	{
		...storyModel,
		providerId: "0199a3a0-0000-7000-8000-000000000203",
		providerName: "Ollama",
		providerBuiltIn: "ollama",
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
				instructions:
					"Work the Revenue pipeline. Draft replies in the rep's voice, keep them short, and never send without asking.",
			}
		: bot,
);

function connector(
	n: number,
	name: string,
	handle: string,
	url: string,
	tools: ConnectorTool[],
): TestConnector {
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
		signedInAs: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const projectTools: TestConnector[] = [
	connector(1, "HubSpot", "hubspot", "https://mcp.hubspot.com/mcp", [
		{ name: "search_contacts", description: "Find contacts", readOnly: true, destructive: false },
		{ name: "update_deal", description: "Change a deal", readOnly: false, destructive: false },
	]),
	connector(2, "Gmail", "gmail", "https://gmail.mcp.example.com/mcp", [
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
	automation(
		2,
		"Inbound lead",
		{ kind: "webhook", deliveryIdHeader: null, auth: { kind: "bearer" } },
		"paused",
	),
];

const meta = preview.meta({
	title: "Views/Bot settings",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ models, bots }));
	},
	render: () => <StoryApp path={cardPath} />,
});

/**
 * Growth Desk's contact card, its Settings page: its
 * face, with the pencil that changes its avatar, and the way to message it,
 * about, tools and automations.
 */
export const ContactCard = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Built-in tools" })).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: "Connectors" })).toBeInTheDocument();
		await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(growthDesk.name);
		await expect(canvas.getByRole("textbox", { name: "Description" })).toBeInTheDocument();
		// No computers are set up for the workspace, so the bot's is off and can't be turned on.
		await waitFor(() =>
			expect(canvas.getByRole("switch", { name: "Turn on Computer" })).toBeDisabled(),
		);
		const computer = canvas.getByRole("switch", { name: "Turn on Computer" });
		await expect(computer).toHaveAttribute("aria-checked", "false");
		// Said under its name, and read with the switch.
		await expect(computer).toHaveAccessibleDescription(/^Computers are off for /);
	},
});

/**
 * The avatar, opened by clicking the bot's face: the bot on a faint tint of its
 * colour, its shape, eyes and colour beside it, and Save, which waits for a
 * change.
 */
export const Avatar = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Change avatar" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `${growthDesk.name}'s avatar`,
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

/** Growth Desk made private, with its members invited by whoever reaches it. */
const privateBots = bots.map((bot) =>
	bot.id === growthDesk.id
		? {
				...bot,
				visibility: "private" as const,
				permissions: { ...bot.permissions, manageMembers: true },
			}
		: bot,
);

/** A member Growth Desk's members invited, whom they may take out again. */
const invited = {
	memberId: "0199a3a0-0000-7000-8000-0000000000e2",
	name: "Ana Lee",
	email: "ana@example.com",
	image: null,
	removable: true,
};

/**
 * A private bot's settings: Private chosen, saying who sees it, and its
 * Members, with Add members and each one but an admin removable.
 */
export const PrivateBotMembers = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/bots/:botId/members`, () =>
				HttpResponse.json([
					{
						memberId: "0199a3a0-0000-7000-8000-0000000000d2",
						name: "Sam Rivera",
						email: "sam@example.com",
						image: null,
						removable: false,
					},
					invited,
				]),
			),
			...appHandlers({ models, bots: privateBots }),
		);
	},
	play: async ({ canvas }) => {
		const visibility = await canvas.findByRole("radiogroup", { name: "Visibility" });
		await expect(within(visibility).getByRole("radio", { name: "Private" })).toBeChecked();
		await expect(
			canvas.getByText(/^Only its members can see it and talk to it/),
		).toBeInTheDocument();
		await expect(await canvas.findByRole("heading", { name: "Members" })).toBeInTheDocument();
		await expect(await canvas.findByText(invited.name)).toBeInTheDocument();
		await expect(
			canvas.getByRole("button", { name: `Remove ${invited.name}` }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Sam Rivera" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Add members" })).toBeInTheDocument();
	},
});

/**
 * Making a public bot private asks first, saying who will see it and that it
 * leaves the public projects it is in.
 */
export const MakingPrivate = meta.story({
	play: async ({ canvas, userEvent }) => {
		const visibility = await canvas.findByRole("radiogroup", { name: "Visibility" });
		await userEvent.click(within(visibility).getByRole("radio", { name: "Private" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `Make ${growthDesk.name} private?`,
		});
		await expect(
			within(dialog).getByText(/It will leave every public project it's in/),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Make private" })).toBeInTheDocument();
	},
});

/**
 * Making a bot private is refused while it leads a public project: the
 * confirmation stays open and says which project needs another lead bot.
 */
export const MakingPrivateWhileLeading = meta.story({
	beforeEach({ msw }) {
		const refusal = `${growthDesk.name} leads ${revenue.name}. Choose another lead bot for it first.`;
		msw.use(
			http.patch(`${API}/bots/:botId`, () =>
				HttpResponse.json(
					{
						_tag: "Conflict",
						message: refusal,
						error: { _tag: "LeadsProjects", userMessage: refusal, isRetryable: false },
					},
					{ status: 409 },
				),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const visibility = await canvas.findByRole("radiogroup", { name: "Visibility" });
		await userEvent.click(within(visibility).getByRole("radio", { name: "Private" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `Make ${growthDesk.name} private?`,
		});
		await userEvent.click(within(dialog).getByRole("button", { name: "Make private" }));
		await expect(
			await within(dialog).findByText(/Choose another lead bot for it first/),
		).toBeInTheDocument();
	},
});

/**
 * Making a private bot public asks first, saying everyone will see it and that
 * its invited members are removed, so making it private again starts over.
 */
export const MakingPublic = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ models, bots: privateBots }));
	},
	play: async ({ canvas, userEvent }) => {
		const visibility = await canvas.findByRole("radiogroup", { name: "Visibility" });
		await userEvent.click(within(visibility).getByRole("radio", { name: "Public" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `Make ${growthDesk.name} public?`,
		});
		await expect(within(dialog).getByText(/Its invited members are removed/)).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Make public" })).toBeInTheDocument();
	},
});

/** A viewer, who may not change the bot, reads its visibility rather than choosing it. */
export const VisibilityForViewer = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				models,
				role: "viewer",
				bots: bots.map((bot) => ({
					...bot,
					permissions: { ...bot.permissions, update: false, delete: false },
				})),
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/^Everyone in the workspace can see it/),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("radiogroup", { name: "Visibility" })).toBeNull();
		await expect(canvas.getByText("Public")).toBeInTheDocument();
	},
});

/** A member of a private bot may take themselves out, after a word that they'll lose it. */
export const RemovingYourself = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/bots/:botId/members`, () =>
				HttpResponse.json([
					{
						memberId: storyMember.id,
						name: storyMember.name,
						email: storyMember.email,
						image: null,
						removable: true,
					},
					invited,
				]),
			),
			...appHandlers({ models, bots: privateBots }),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Remove yourself" }));
		const dialog = await within(document.body).findByRole("dialog", {
			name: `Remove yourself from ${growthDesk.name}?`,
		});
		await expect(
			within(dialog).getByText(/You won't see it or its chats any more/),
		).toBeInTheDocument();
	},
});

/** An editor in the workspace, who may not change the bot. */
function editorHandlers() {
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
					pauseAutomations: false,
					manageConnectors: false,
					manageComputer: false,
				},
			},
		})),
		role: "editor",
	});
}

/** The model for an editor: stated, not a menu to choose from. */
export const EditorModelPage = meta.story({
	beforeEach({ msw }) {
		msw.use(...editorHandlers());
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

/** A bot with its connectors, each with how many tools it can use, and its two automations counted, with the way to its Automations page. */
export const ToolsAndAutomations = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...connectorHandlers(projectTools),
			http.get(`${API}/projects/:projectId/automations`, () => HttpResponse.json(automations)),
		);
	},
	play: async ({ canvas }) => {
		const connectors = await canvas.findByRole("region", { name: "Connectors" });
		await expect(await within(connectors).findByText("HubSpot")).toBeInTheDocument();
		await expect(within(connectors).getAllByText("2 tools")).not.toHaveLength(0);
		await expect(within(connectors).queryByRole("switch")).toBeNull();
		// Its settings' row, not the Automations beside its chats.
		const settings = canvas.getByRole("region", { name: "Settings" });
		const automationsRow = within(settings).getByRole("link", { name: /^Automations/ });
		await waitFor(() => expect(within(automationsRow).getByText("2")).toBeInTheDocument());
		await expect(automationsRow).toHaveAttribute(
			"href",
			`/nitric/bots/${growthDesk.handle}/automations`,
		);
	},
});

/** An editor, who may not change the bot: its settings stated rather than editable. */
export const Editor = meta.story({
	beforeEach({ msw }) {
		msw.use(...editorHandlers());
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete bot" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Change avatar" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New bot" })).toBeNull();
	},
});

/** An admin opens another member's personal bot from the directory to reach Delete. */
export const AdminOnPersonalBot = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ models, bots: [...bots, personalBot], role: "admin" }));
	},
	render: () => <StoryApp path="/nitric/bots" />,
	play: async ({ canvas }) => {
		const directory = await canvas.findByRole("region", { name: "In this workspace" });
		await userEvent.click(within(directory).getByRole("link", { name: personalBot.name }));
		await expect(await canvas.findByRole("button", { name: "Delete bot" })).toBeEnabled();
		await expect(canvas.queryByRole("region", { name: "Connectors" })).toBeNull();
	},
});

/** On a phone the card is a page of the bot's, with the way back to it. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
		await expect(
			canvas.getByRole("link", { name: `Back to ${growthDesk.name}` }),
		).toBeInTheDocument();
	},
});
