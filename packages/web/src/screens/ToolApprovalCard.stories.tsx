import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

const look: ConnectionLook = { name: "Linear", presetId: "linear" };

const agent = { name: "Linear Handler", color: "green" as const, face: "pill" as const };

function pending(over: Partial<ToolCallPart> = {}): ToolCallPart {
	return {
		type: "tool_call",
		id: "0199a3a0-0000-7000-8000-000000000001",
		tool: "linear__create_issue",
		input: {
			team: "Platform",
			title: "Checkout requests time out at the 30s gateway limit",
			priority: "Urgent",
			description:
				"41 Sentry events in 24h, all on POST /checkout, every one hitting the same 30s gateway limit. First seen Friday evening, climbing since. No Linear issue covers it yet. The slowest requests all carry more than 40 line items, which points at the tax lookup running once per item rather than once per basket.",
		},
		output: null,
		status: "awaiting_approval",
		error: null,
		mutating: true,
		atOffset: 0,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		approval: { status: "pending", decidedByName: null, decidedAt: null },
		...over,
	};
}

const meta = preview.meta({
	title: "Product/ToolApprovalCard",
	component: ToolApprovalCard,
	tags: ["ai-generated"],
	args: {
		call: pending(),
		agent,
		threadId: "0199a3a0-0000-7000-8000-0000000000b2",
		podId: "0199a3a0-0000-7000-8000-0000000000b1",
		canApprove: true,
		look,
	},
	decorators: [
		function WithQueries(Story) {
			const [queryClient] = useState(
				() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
			);
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="mx-auto py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/** Waiting is a bot's write held for an answer: what it would do and where, then Allow or Deny. */
export const Waiting = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Allow" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Deny" })).toBeInTheDocument();
		await expect(canvas.queryByRole("checkbox")).toBeNull();
	},
});

/** NotYoursToAnswer is the same request seen by someone who cannot answer it. */
export const NotYoursToAnswer = meta.story({ args: { canApprove: false } });

/** TheFullRequestOpened lays out everything it would send, behind the tool's name. */
export const TheFullRequestOpened = meta.story({
	args: {
		call: pending({
			tool: "linear__update_issue",
			input: {
				issueId: "NIT-1846",
				labels: ["performance", "chat", "backend"],
				assignee: { id: "u_123", name: "Tim Holm", email: "tim.holm@nitric.io" },
				subscribers: Array.from({ length: 12 }, (_, index) => ({ id: `u_${index}`, notify: true })),
			},
		}),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /View the full request/ }));
	},
});

/** ConnectionSinceRemoved is a call to a connection the pod no longer has: the handle is written out. */
export const ConnectionSinceRemoved = meta.story({ args: { look: undefined } });
