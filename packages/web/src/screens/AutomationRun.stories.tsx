import type { ChatMessageItem } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import { RunMessage } from "./AutomationRun.tsx";

const endedEarly: Extract<ChatMessageItem, { kind: "run" }> = {
	kind: "run",
	id: "0199a3a0-0000-7000-8000-000000000403",
	chatId: "0199a3a0-0000-7000-8000-000000000404",
	automationName: "Overnight outbound",
	triggerKind: "routine",
	state: "cancelled",
	error: null,
	reply: null,
	createdAt: "2026-09-18T06:00:00.000Z",
};

const meta = preview.meta({
	title: "Product/Automation Run",
	component: RunMessage,
	decorators: [
		function WithQueries(Story) {
			const [client] = useState(() => new QueryClient());
			return (
				<QueryClientProvider client={client}>
					<Story />
				</QueryClientProvider>
			);
		},
	],
	args: {
		item: endedEarly,
		bot: { ...growthDesk, kind: "bot" },
		automation: { id: "0199a3a0-0000-7000-8000-000000000405", projectId: revenue.id },
		chatId: "0199a3a0-0000-7000-8000-000000000401",
		latest: false,
		mentionable: [],
	},
});

/** EndedEarly records a run that ended without a result. */
export const EndedEarly = meta.story({
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("article", { name: "Overnight outbound: Cancelled" }),
		).toHaveTextContent("The run ended early.");
	},
});

/** ShowsItsWork draws the work a run's reply did over what it said, opening to its steps. */
export const ShowsItsWork = meta.story({
	args: {
		item: {
			...endedEarly,
			state: "completed",
			reply: {
				id: "0199a3a0-0000-7000-8000-000000000406",
				chatId: "0199a3a0-0000-7000-8000-000000000404",
				author: { ...growthDesk, kind: "bot" },
				status: "complete",
				parts: [
					{ type: "text", text: "Checking last night's sign-ups." },
					{
						type: "tool_call",
						id: "0199a3a0-0000-7000-8000-000000000407",
						tool: "web_search",
						input: { query: "sign-ups" },
						output: { results: [] },
						status: "completed",
						error: null,
						approval: null,
						atOffset: "Checking last night's sign-ups.".length,
						startedAt: "2026-09-18T06:00:05.000Z",
						finishedAt: "2026-09-18T06:00:09.000Z",
					},
					{ type: "text", text: "Twelve new sign-ups overnight, all from the pricing page." },
				],
				content:
					"Checking last night's sign-ups.Twelve new sign-ups overnight, all from the pricing page.",
				createdAt: "2026-09-18T06:00:00.000Z",
				finishedAt: "2026-09-18T06:01:30.000Z",
			},
		},
	},
	play: async ({ canvas, userEvent }) => {
		await expect(
			canvas.getByText("Twelve new sign-ups overnight, all from the pricing page."),
		).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Worked for 1m 30s" }));
		await expect(await canvas.findByText("Checking last night's sign-ups.")).toBeVisible();
	},
});
