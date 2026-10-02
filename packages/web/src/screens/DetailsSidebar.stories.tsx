import type {
	Connection,
	Routine,
	SessionUser,
	SystemAgent,
	ThreadActivity,
	ThreadParticipant,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { DetailsSidebar } from "./DetailsSidebar.tsx";

const WORKSPACE = growthDesk.workspaceId;

const user: SessionUser = {
	id: "0199a3a0-0000-7000-8000-000000000501",
	name: "Ryan Eyes",
	email: "ryan@example.com",
	image: null,
} as SessionUser;

const people: ThreadParticipant[] = [
	["Jay Young", "0199a3a0-0000-7000-8000-000000000502"],
	["Ryan Eyes", user.id],
	["Mara Kent", "0199a3a0-0000-7000-8000-000000000503"],
	["Sam Park", "0199a3a0-0000-7000-8000-000000000504"],
	["Alex Lee", "0199a3a0-0000-7000-8000-000000000505"],
].map(([name, id]) => testPerson({ id: id as string, name: name as string }));

const threadId = "0199a3a0-0000-7000-8000-000000000510";

const activity: ThreadActivity = {
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
	recentParticipants: people,
};

const scribe: SystemAgent = {
	key: "summarise",
	name: "Scribe",
	description: null,
	color: "orange",
	face: "arc",
	model: "claude-sonnet-4-5",
} as SystemAgent;

function routine(id: string, name: string, expression: string): Routine {
	return {
		id,
		workspaceId: WORKSPACE,
		agentId: growthDesk.id,
		name,
		instructions: "Do the thing.",
		trigger: { kind: "cron", expression, timezone: "Australia/Sydney", nextScheduledAt: null },
		state: "enabled",
		createdById: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	} as Routine;
}

const routines = [
	routine("0199a3a0-0000-7000-8000-000000000521", "Overnight outbound", "0 6 * * *"),
	routine("0199a3a0-0000-7000-8000-000000000522", "Reply digest", "0 9 * * 1-5"),
	routine("0199a3a0-0000-7000-8000-000000000523", "Pipeline review", "0 16 * * 5"),
];

function connection(id: string, name: string, url: string): Connection {
	return {
		id,
		workspaceId: WORKSPACE,
		podId: revenue.id,
		name,
		handle: name.toLowerCase(),
		url,
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
		access: "allow",
		status: "connected",
		tools: [],
		lastTestedAt: null,
		lastTestError: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	} as Connection;
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
	args: { agent: growthDesk, pod: revenue, threadId, user, onClose: fn() },
	decorators: [
		function WithQueries(Story, context) {
			const scribeHasModel = context.parameters.scribeHasModel !== false;
			const [queryClient] = useState(() => {
				const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
				client.setQueryData(["routines", "agent", growthDesk.id], routines);
				client.setQueryData(["connections", revenue.id], connections);
				client.setQueryData(
					["workspaces"],
					[{ id: WORKSPACE, name: "Nitric", slug: "nitric", timeZone: "UTC" }],
				);
				client.setQueryData(
					["built-in-agents", WORKSPACE],
					[scribeHasModel ? scribe : { ...scribe, model: null }],
				);
				client.setQueryData(
					["thread-activity", threadId],
					scribeHasModel ? activity : { ...activity, summary: null },
				);
				return client;
			});
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="flex h-[860px] justify-end bg-background">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/** Default is a bot's contact card beside its chat, each list folded to its first few. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Growth Desk" })).toBeVisible();
		await expect(canvas.getByText("You")).toBeVisible();
		await expect(canvas.getByRole("meter", { name: "Short-term memory used" })).toBeVisible();
		await expect(canvas.queryByText("Sam Park")).toBeNull();
	},
});

/** Expanded opens each folded list and the summary. */
export const Expanded = meta.story({
	play: async ({ canvas, userEvent }) => {
		for (const more of canvas.getAllByRole("button", { name: "Show more" })) {
			await userEvent.click(more);
		}
		await expect(canvas.getByText("Sam Park")).toBeVisible();
		await expect(canvas.getByText("Pipeline review")).toBeVisible();
	},
});

/** Beside the chat, the header's ⓘ closes it, so it has no Close of its own. */
export const ClosedFromTheHeader = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: "Close" })).toBeNull();
	},
});

/** On a phone it covers the header too, so it has a Close that calls back to put it away. */
export const CloseOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Close" }));
		await expect(args.onClose).toHaveBeenCalled();
	},
});

/** Before the Scribe has a model there is no summary, and it says so rather than staying blank. */
export const ScribeNotSetUp = meta.story({
	parameters: { scribeHasModel: false },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/The Scribe writes these/)).toBeVisible();
	},
});
