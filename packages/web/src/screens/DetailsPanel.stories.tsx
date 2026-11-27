import type {
	Automation,
	ChatContext,
	Connector,
	CurrentUser,
	Participant,
} from "@sugabots/contracts";
import { automationTriggers, testMember } from "@sugabots/contracts/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { storyModel } from "@/story-app.test-support.tsx";
import { DetailsPanel } from "./DetailsPanel.tsx";

const WORKSPACE = growthDesk.workspaceId;

const signedIn: CurrentUser = {
	id: "0199a3a0-0000-7000-8000-000000000501",
	name: "Rowan Ellis",
	email: "rowan@example.com",
	image: null,
} as CurrentUser;

const members: Participant[] = [
	["Jay Young", "0199a3a0-0000-7000-8000-000000000502"],
	["Rowan Ellis", signedIn.id],
	["Mara Kent", "0199a3a0-0000-7000-8000-000000000503"],
	["Sam Park", "0199a3a0-0000-7000-8000-000000000504"],
	["Alex Lee", "0199a3a0-0000-7000-8000-000000000505"],
].map(([name, id]) => testMember({ id: id as string, name: name as string }));

const chatId = "0199a3a0-0000-7000-8000-000000000510";

const measuredContext: ChatContext = {
	usedTokens: 48_200,
	measuredAt: "2026-09-25T06:12:00.000Z",
	windowTokens: 256_000,
	compactionLineTokens: 179_200,
	compactedAt: null,
};

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
		pausedAfterFailures: false,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	};
}

const automations = [
	automation("0199a3a0-0000-7000-8000-000000000521", "Overnight outbound", "0 6 * * *"),
	automation("0199a3a0-0000-7000-8000-000000000522", "Reply digest", "0 9 * * 1-5"),
	automation("0199a3a0-0000-7000-8000-000000000523", "Pipeline review", "0 16 * * 5"),
];

function connector(id: string, name: string, url: string): Connector {
	return {
		id,
		workspaceId: WORKSPACE,
		projectId: growthDesk.defaultProjectId,
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
		lastTestError: null,
		connectedBy: null,
		signedInAs: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

const connectors = [
	connector("0199a3a0-0000-7000-8000-000000000531", "HubSpot", "https://mcp.hubspot.example/mcp"),
	connector("0199a3a0-0000-7000-8000-000000000532", "Linear", "https://mcp.linear.app/mcp"),
	connector("0199a3a0-0000-7000-8000-000000000533", "Notion", "https://mcp.notion.com/mcp"),
];

const meta = preview.meta({
	title: "Product/DetailsPanel",
	component: DetailsPanel,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		bot: growthDesk,
		chatId,
		contents: {
			participants: members,
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
			const [queryClient] = useState(() => {
				const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
				client.setQueryData(["automations", "project", growthDesk.defaultProjectId], automations);
				client.setQueryData(
					["connectors", growthDesk.defaultProjectId],
					context.parameters.connectors ?? connectors,
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
							setUpAt: "2026-09-01T00:00:00.000Z",
						},
					],
				);
				client.setQueryData(["chat-context", chatId], measuredContext);
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
 * Default is a bot beside its chat from a tablet up: floating cards of what
 * it works with, the files shared in the chat, and its computer.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		// The cards fade in under the button that opened them.
		await waitFor(() => expect(canvas.getByRole("heading", { name: "Context" })).toBeVisible());
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

/** On a phone, the bot heads them, its name and model, with the way to its settings and automations. */
export const OnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Growth Desk" })).toBeVisible();
		await expect(canvas.getByText(storyModel.displayName)).toBeVisible();
		await expect(canvas.getByText("Settings")).toBeVisible();
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

/**
 * A connector whose sign-in expired says so under its name, in place of its
 * tool count, with a sign-in beside it for someone who manages the bot's connectors.
 */
export const SignInExpired = meta.story({
	parameters: {
		connectors: connectors.map((connector) =>
			connector.handle === "linear"
				? { ...connector, signedIn: false, signInExpired: true }
				: connector,
		),
	},
	play: async ({ canvas }) => {
		const tools = canvas.getByRole("heading", { name: "Context" }).closest("section");
		if (!tools) throw new Error("The details have no Context section");
		await waitFor(() => expect(within(tools).getByText("Sign-in expired")).toBeVisible());
		await expect(within(tools).getByRole("button", { name: "Sign in to Linear" })).toBeVisible();
		await expect(within(tools).getAllByText("1 tool")).toHaveLength(2);
	},
});
