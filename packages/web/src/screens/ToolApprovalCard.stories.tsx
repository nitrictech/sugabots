import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { DeniedToolLine, ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { toolActivityOf } from "./tool-activity.ts";

const look: ConnectionLook = { name: "Linear", presetId: "linear", hue: 262 };

/*
 * `startedAt` is now, not a fixed instant, because the header counts how long
 * the run has been waiting and a fixed one would read in years.
 */
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
				"41 Sentry events in 24h, all on POST /checkout, every one hitting the same 30s gateway limit. First seen Friday evening, climbing since. No Linear issue covers it yet.",
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
		threadId: "0199a3a0-0000-7000-8000-0000000000b2",
		podId: "0199a3a0-0000-7000-8000-0000000000b1",
		canApprove: true,
		canAlwaysAllow: false,
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
					<div className="mx-auto max-w-home py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/** The request: what it would do, what it would send, and the two answers. */
export const Waiting = meta.story({});

/** With the standing permission on offer, for someone who can grant one. */
export const CanAlwaysAllow = meta.story({ args: { canAlwaysAllow: true } });

/** Seen by someone who cannot answer it — the run is stopped for them too. */
export const NotYoursToAnswer = meta.story({ args: { canApprove: false } });

/** An argument long enough to hide the shape of the record is cut short. */
export const ALongArgumentOpened = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Show all" }));
	},
});

/** A call to a connection the pod no longer has: the handle is written out. */
export const ConnectionSinceRemoved = meta.story({ args: { look: undefined } });

/** What a refusal leaves in the thread, which an approval deliberately does not. */
export const AfterDenying = meta.story({
	render: () => {
		const denied = pending({
			approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
		});
		return (
			<DeniedToolLine
				call={denied}
				activity={toolActivityOf({ parts: [denied] }, new Map([["linear", "Linear"]]))}
				looks={new Map([["linear", look]])}
			/>
		);
	},
});
