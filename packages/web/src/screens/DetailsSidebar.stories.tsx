import type {
	Automation,
	Connection,
	ConversationActivity,
	Participant,
	SessionUser,
	SystemBot,
} from "@sugabots/contracts";
import { automationTriggers, testPerson } from "@sugabots/contracts/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.ts";
import { storyModel } from "@/story-app.tsx";
import { DetailsSidebar } from "./DetailsSidebar.tsx";

const WORKSPACE = growthDesk.workspaceId;

const user: SessionUser = {
	id: "0199a3a0-0000-7000-8000-000000000501",
	name: "Rowan Ellis",
	email: "rowan@example.com",
	image: null,
} as SessionUser;

const people: Participant[] = [
	["Jay Young", "0199a3a0-0000-7000-8000-000000000502"],
	["Rowan Ellis", user.id],
	["Mara Kent", "0199a3a0-0000-7000-8000-000000000503"],
	["Sam Park", "0199a3a0-0000-7000-8000-000000000504"],
	["Alex Lee", "0199a3a0-0000-7000-8000-000000000505"],
].map(([name, id]) => testPerson({ id: id as string, name: name as string }));

const conversationId = "0199a3a0-0000-7000-8000-000000000510";

const activity: ConversationActivity = {
	summary: {
		content:
			"Overnight outbound queued 38 leads and six have replied, including both Northwind accounts asking about pricing. Jay wants short replies drafted. Checkout timeouts are back; Linear Handler found 41 events and is waiting on approval to open an issue. Nothing else is outstanding from this week.",
		sourceMessageId: "0199a3a0-0000-7000-8000-000000000512",
		updatedAt: "2026-09-25T06:12:00.000Z",
	},
	context: {
		usedTokens: 48_200,
		measuredAt: "2026-09-25T06:12:00.000Z",
		windowTokens: 256_000,
		compactionLineTokens: 179_200,
		compactedAt: null,
	},
};

const summariser: SystemBot = {
	key: "summarise",
	name: "Summariser",
	description: null,
	color: "orange",
	face: "arc",
	model: "claude-sonnet-4-5",
} as SystemBot;

function automation(id: string, name: string, expression: string): Automation {
	return {
		id,
		workspaceId: WORKSPACE,
		projectId: growthDesk.defaultProjectId,
		name,
		instructions: "Do the thing.",
		triggers: automationTriggers(id, {
			kind: "routine",
			schedule: { repeat: "cron", expression },
			timezone: "Australia/Sydney",
			nextScheduledAt: null,
		}),
		state: "enabled",
		createdById: null,
		createdByBotId: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	};
}

const automations = [
	automation("0199a3a0-0000-7000-8000-000000000521", "Overnight outbound", "0 6 * * *"),
	automation("0199a3a0-0000-7000-8000-000000000522", "Reply digest", "0 9 * * 1-5"),
	automation("0199a3a0-0000-7000-8000-000000000523", "Pipeline review", "0 16 * * 5"),
];

function connection(id: string, name: string, url: string): Connection {
	return {
		id,
		workspaceId: WORKSPACE,
		projectId: growthDesk.id,
		name,
		handle: name.toLowerCase(),
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		signInExpired: false,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		toolCounts: { allow: 1, ask: 0, off: 0 },
		lastTestedAt: null,
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const connections = [
	connection("0199a3a0-0000-7000-8000-000000000531", "HubSpot", "https://mcp.hubspot.example/mcp"),
	connection("0199a3a0-0000-7000-8000-000000000532", "Linear", "https://mcp.linear.app/mcp"),
	connection("0199a3a0-0000-7000-8000-000000000533", "Notion", "https://mcp.notion.com/mcp"),
];

const meta = preview.meta({
	title: "Product/DetailsSidebar",
	component: DetailsSidebar,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		bot: growthDesk,
		conversationId,
		contents: {
			participants: people,
			files: [
				{
					type: "file" as const,
					id: "0199a3a0-0000-7000-8000-0000000005f9",
					name: "northwind-pricing.pdf",
					contentType: "application/pdf",
					size: 48_210,
				},
			],
			fileUrlOf: (fileId: string) => `https://files.example/${fileId}`,
		},
		onOpenAutomations: fn(),
		onOpenDesktop: fn(),
		onClose: fn(),
	},
	decorators: [
		function WithQueries(Story, context) {
			const summariserHasModel = context.parameters.summariserHasModel !== false;
			const [queryClient] = useState(() => {
				const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
				client.setQueryData(["automations", "bot", growthDesk.id], automations);
				client.setQueryData(
					["connections", growthDesk.id],
					context.parameters.connections ?? connections,
				);
				client.setQueryData(["models", WORKSPACE], { models: [storyModel] });
				client.setQueryData(
					["workspaces"],
					[
						{
							id: WORKSPACE,
							name: "Nitric",
							slug: "nitric",
							timeZone: "UTC",
							setupCompletedAt: "2026-09-01T00:00:00.000Z",
						},
					],
				);
				client.setQueryData(
					["system-bots", WORKSPACE],
					[summariserHasModel ? summariser : { ...summariser, model: null }],
				);
				client.setQueryData(
					["conversation-activity", conversationId],
					summariserHasModel ? activity : { ...activity, summary: null },
				);
				return client;
			});
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="flex h-215 justify-end bg-background">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/**
 * Default is a bot beside its thread from a tablet up: floating cards of what
 * it works with, the files shared in the thread, and its computer.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Context" })).toBeVisible();
		await expect(canvas.getByRole("meter", { name: "Short-term memory used" })).toBeInTheDocument();
		await expect(canvas.getByRole("link", { name: "northwind-pricing.pdf" })).toBeVisible();
		await expect(canvas.getByRole("heading", { name: "Computer" })).toBeVisible();
	},
});

/** Each card folds to its title when its title is clicked, and opens again the same way. */
export const CardFolded = meta.story({
	play: async ({ canvas, userEvent }) => {
		const title = canvas.getByRole("button", { name: "Context" });
		await userEvent.click(title);
		await expect(title).toHaveAttribute("aria-expanded", "false");
		await expect(canvas.queryByRole("meter", { name: "Short-term memory used" })).toBeNull();
		await userEvent.click(title);
		await expect(canvas.getByRole("meter", { name: "Short-term memory used" })).toBeInTheDocument();
	},
});

/** On a phone, the bot heads them, its name and model, with what the thread is about under it. */
export const OnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Growth Desk" })).toBeVisible();
		await expect(canvas.getByText(storyModel.displayName)).toBeVisible();
		await expect(canvas.getByRole("heading", { name: "Summary" })).toBeVisible();
	},
});

/** On a phone it covers the chat's header too, so it has the round Back, which calls back to put it away. */
export const CloseOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Back" }));
		await expect(args.onClose).toHaveBeenCalled();
	},
});

/** Before the system bots have a model there is no summary, and it says so rather than staying blank. */
export const SystemBotsNotSetUp = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	parameters: { summariserHasModel: false },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/The system bots write these/)).toBeVisible();
	},
});

/**
 * A connection whose sign-in expired says so under its name, in place of its
 * tool count, with a sign-in beside it for someone who manages the bot's connections.
 */
export const SignInExpired = meta.story({
	parameters: {
		connections: connections.map((connection) =>
			connection.handle === "linear"
				? { ...connection, signedIn: false, signInExpired: true }
				: connection,
		),
	},
	play: async ({ canvas }) => {
		const tools = canvas.getByRole("heading", { name: "Context" }).closest("section");
		if (!tools) throw new Error("The details have no Context section");
		await expect(within(tools).getByText("Sign-in expired")).toBeVisible();
		await expect(within(tools).getByRole("button", { name: "Sign in to Linear" })).toBeVisible();
		await expect(within(tools).getAllByText("1 tool")).toHaveLength(2);
	},
});
