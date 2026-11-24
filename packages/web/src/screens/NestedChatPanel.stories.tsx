import type { ChatDetails, ListedAutomationDefinition } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.ts";
import { NestedChatPanel } from "./NestedChatPanel.tsx";

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const RUN = "0199a3a0-0000-7000-8000-000000000403";
const runBot = {
	kind: "bot" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	eyes: growthDesk.eyes,
	shape: growthDesk.shape,
};

/** An automation run a webhook started, which posted its result in the chat. */
function automationRun(failed: boolean): ChatDetails {
	return {
		chat: {
			id: RUN,
			workspaceId: revenue.workspaceId,
			projectId: revenue.id,
			botId: growthDesk.id,
			rootChatId: CHAT,
			kind: "run",
			title: "Overnight outbound",
			working: false,
			resolvedAt: null,
			createdAt: "2026-09-18T06:00:00.000Z",
			updatedAt: "2026-09-18T06:02:00.000Z",
		},
		permissions: { approveToolCalls: true, approveComputerRequests: true },
		participants: [runBot],
		projectBots: [runBot],
		membersReachingProject: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		automationRun: {
			id: "0199a3a0-0000-7000-8000-000000000404",
			automationId: "0199a3a0-0000-7000-8000-000000000405",
			workspaceId: revenue.workspaceId,
			botId: growthDesk.id,
			chatId: RUN,
			rootChatId: CHAT,
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
			: [
					{
						id: "0199a3a0-0000-7000-8000-000000000415",
						chatId: RUN,
						author: runBot,
						status: "complete",
						parts: [
							{
								type: "text",
								text: "Queued 38 leads. Six have replied; drafts are in the outbox.",
							},
						],
						content: "Queued 38 leads. Six have replied; drafts are in the outbox.",
						createdAt: "2026-09-18T06:02:00.000Z",
					},
				],
	};
}

function Preview({ children, run }: { children: React.ReactNode; run: ChatDetails }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		if (run.automationRun) {
			client.setQueryData(["chat", RUN], run);
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
		client.setQueryData(["connectors", revenue.id], []);
		// The run's link to its automation is found through the bot.
		client.setQueryData(
			["workspaces"],
			[
				{
					id: revenue.workspaceId,
					name: "Nitric",
					slug: "nitric",
					timeZone: "UTC",
					setUpAt: "2026-09-01T00:00:00.000Z",
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
	title: "Product/NestedChatPanel",
	component: NestedChatPanel,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		chatId: CHAT,
		nestedChatId: RUN,
		back: { to: "bot" as const, bot: growthDesk },
		trailing: null,
	},
});

/** An automation run a webhook started: its name, what it posted, and the payload behind the braces. */
export const AutomationRun = meta.story({
	render: (args) => (
		<Preview run={automationRun(false)}>
			<div className="relative flex h-screen justify-end bg-background">
				<NestedChatPanel {...args} />
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
	render: (args) => (
		<Preview run={automationRun(true)}>
			<div className="relative flex h-screen justify-end bg-background">
				<NestedChatPanel {...args} />
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
