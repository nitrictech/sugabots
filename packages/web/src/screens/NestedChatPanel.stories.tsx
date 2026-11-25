import type { ChatDetails, ListedAutomationDefinition } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { SessionContext } from "@/lib/session.ts";
import { growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.test-support.ts";
import { storyMember } from "@/story-app.test-support.tsx";
import { automationRun, CHAT, RUN } from "./NestedChatPanel.test-support.ts";
import { NestedChatPanel } from "./NestedChatPanel.tsx";

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
	return (
		<SessionContext value={{ member: storyMember, error: undefined, refresh: async () => {} }}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</SessionContext>
	);
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
		await waitFor(() => expect(within(document.body).getByText(/crm-2026-09-18/)).toBeVisible());
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
