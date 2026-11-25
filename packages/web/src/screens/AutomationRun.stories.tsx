import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import { RunMessage } from "./AutomationRun.tsx";

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
		item: {
			kind: "run",
			id: "0199a3a0-0000-7000-8000-000000000403",
			chatId: "0199a3a0-0000-7000-8000-000000000404",
			automationName: "Overnight outbound",
			triggerKind: "routine",
			state: "cancelled",
			error: null,
			report: null,
			createdAt: "2026-09-18T06:00:00.000Z",
		},
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
