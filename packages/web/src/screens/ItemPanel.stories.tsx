import type { ConversationDetails, ListedAutomationDefinition, Message } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.ts";
import { ItemPanel } from "./ItemPanel.tsx";

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const COLLABORATION = "0199a3a0-0000-7000-8000-000000000402";
const user = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Rowan Ellis",
	email: "rowan@example.com",
};

const asker = {
	kind: "bot" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
	shape: growthDesk.shape,
};
const answerer = {
	kind: "bot" as const,
	id: linearHandler.id,
	name: linearHandler.name,
	handle: linearHandler.handle,
	color: linearHandler.color,
	face: linearHandler.face,
	shape: linearHandler.shape,
};

function message(
	id: string,
	author: typeof asker,
	text: string,
	before: Message["parts"] = [],
): Message {
	return {
		id: `0199a3a0-0000-7000-8000-00000000041${id}`,
		conversationId: COLLABORATION,
		author,
		kind: "text",
		status: "complete",
		parts: [...before, { type: "text", text }],
		content: text,
		createdAt: "2026-09-18T06:04:00.000Z",
	};
}

const collaboration: ConversationDetails = {
	conversation: {
		id: COLLABORATION,
		workspaceId: revenue.workspaceId,
		projectId: revenue.id,
		botId: linearHandler.id,
		rootConversationId: CHAT,
		kind: "collaboration",
		title: "Checkout timeouts",
		status: "running",
		parentConversationId: null,
		startedById: user.id,
		doneAt: null,
		createdAt: "2026-09-18T06:04:00.000Z",
		updatedAt: "2026-09-18T06:05:00.000Z",
	},
	capabilities: { approveToolCalls: true },
	automationRun: null,
	participants: [answerer, asker],
	projectBots: [asker, answerer],
	peopleReachingProject: [],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		message(
			"1",
			asker,
			"Rowan is seeing checkout timeouts. Check Sentry and open an issue if nothing's tracked?",
		),
		message(
			"2",
			answerer,
			"41 events in 24h, all hitting the 30s gateway limit. Nothing open in Linear.",
			[
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-000000000420",
					tool: "linear__create_issue",
					input: { title: "Checkout requests time out" },
					output: null,
					status: "awaiting_approval",
					error: null,
					mutating: true,
					atOffset: 0,
					startedAt: "2026-09-18T06:05:00.000Z",
					finishedAt: null,
					approval: { status: "pending", decidedByName: null, decidedAt: null },
				},
			],
		),
	],
};

const RUN = "0199a3a0-0000-7000-8000-000000000403";

/** An automation run a webhook started, which posted its result in the chat. */
function automationRun(failed: boolean): ConversationDetails {
	return {
		...collaboration,
		conversation: {
			...collaboration.conversation,
			id: RUN,
			botId: growthDesk.id,
			kind: "run",
			title: "Overnight outbound",
			status: "done",
		},
		participants: [asker],
		projectBots: [asker],
		automationRun: {
			id: "0199a3a0-0000-7000-8000-000000000404",
			automationId: "0199a3a0-0000-7000-8000-000000000405",
			workspaceId: revenue.workspaceId,
			botId: growthDesk.id,
			conversationId: RUN,
			rootConversationId: CHAT,
			automationName: "Overnight outbound",
			instructions: "Queue the overnight leads and draft replies to anyone who answered.",
			trigger: {
				kind: "webhook",
				receivedAt: "2026-09-18T06:00:00.000Z",
				idempotencyKey: "crm-2026-09-18",
				payload: { source: "crm", leads: 38 },
			},
			state: failed ? "failed" : "completed",
			error: failed ? "HubSpot did not answer within 30 seconds." : null,
			posted: !failed,
			acceptedAt: "2026-09-18T06:00:00.000Z",
			startedAt: "2026-09-18T06:00:01.000Z",
			finishedAt: "2026-09-18T06:02:00.000Z",
		},
		messages: failed
			? []
			: [message("5", asker, "Queued 38 leads. Six have replied; drafts are in the outbox.")],
	};
}

function Preview({ children, run }: { children: React.ReactNode; run?: ConversationDetails }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["conversation", COLLABORATION], collaboration);
		if (run?.automationRun) {
			client.setQueryData(["conversation", RUN], run);
			// The run is its automation's latest, so a failure may be retried.
			const latest = run.automationRun;
			client.setQueryData(["automations", "project", revenue.id], [
				{
					id: latest.automationId,
					workspaceId: revenue.workspaceId,
					projectId: revenue.id,
					name: latest.automationName,
					instructions: latest.instructions,
					triggers: [],
					state: "enabled",
					pausedAfterFailures: false,
					createdById: null,
					createdAt: latest.acceptedAt,
					updatedAt: latest.acceptedAt,
					status: {
						failing: latest.state === "failed",
						latestRun: {
							id: latest.id,
							state: latest.state,
							posted: latest.posted,
							acceptedAt: latest.acceptedAt,
							error: latest.error,
						},
					},
				},
			] satisfies ListedAutomationDefinition[]);
		}
		client.setQueryData(["connections", revenue.id], []);
		// The run's link to its automation is found through the bot.
		client.setQueryData(
			["workspaces"],
			[
				{
					id: revenue.workspaceId,
					name: "Nitric",
					slug: "nitric",
					timeZone: "UTC",
					setupCompletedAt: "2026-09-01T00:00:00.000Z",
				},
			],
		);
		client.setQueryData(["projects", revenue.workspaceId], [revenue]);
		client.setQueryData(["bots", revenue.workspaceId], [growthDesk, linearHandler]);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Product/ItemPanel",
	component: ItemPanel,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		conversationId: CHAT,
		chatBotId: growthDesk.id,
		itemConversationId: COLLABORATION,
		history: [],
		frame: { kind: "sidebar" as const, onClose: fn() },
		onOpenItem: fn(),
	},
	render: (args) => (
		<Preview>
			<div className="relative flex h-screen justify-end bg-background">
				<ItemPanel {...args} />
			</div>
		</Preview>
	),
});

/**
 * A collaboration waiting on an approval. Beside the chat on a wide screen,
 * answered on its card; on a phone a sheet whose card opens the request full
 * screen to answer it.
 */
export const WaitingOnApproval = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Collaboration" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
	},
});

/** Where a run opens: as a page of its own in Inbox, never beside a chat. */
const RUN_PAGE = { kind: "page" as const, back: { to: "inbox" as const }, trailing: null };

/** An automation run a webhook started: its name, what it posted, and the payload behind the braces. */
export const AutomationRun = meta.story({
	args: { itemConversationId: RUN, frame: RUN_PAGE },
	render: (args) => (
		<Preview run={automationRun(false)}>
			<div className="relative flex h-screen justify-end bg-background">
				<ItemPanel {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "View webhook payload" }));
		// The payload opens in a popover, outside the story's own element.
		await expect(await within(document.body).findByText(/crm-2026-09-18/)).toBeVisible();
	},
});

/**
 * A run that failed says why, as its bot's post in the automation's feed does,
 * and, as the automation's latest run, offers to run it again.
 */
export const FailedAutomationRun = meta.story({
	args: { itemConversationId: RUN, frame: RUN_PAGE },
	render: (args) => (
		<Preview run={automationRun(true)}>
			<div className="relative flex h-screen justify-end bg-background">
				<ItemPanel {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas }) => {
		const failure = await canvas.findByRole("article", { name: "Overnight outbound: Failed" });
		await expect(failure).toHaveTextContent("HubSpot did not answer within 30 seconds.");
		await expect(within(failure).getByRole("button", { name: "Retry" })).toBeVisible();
		await expect(canvas.queryByRole("alert")).toBeNull();
	},
});
