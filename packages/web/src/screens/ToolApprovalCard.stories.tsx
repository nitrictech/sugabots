import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { DeniedToolLine, ToolApprovalCard } from "./ToolApprovalCard.tsx";

const look: ConnectionLook = { name: "Linear", presetId: "linear", hue: 262 };

const agent = { name: "Linear Handler", hue: 158, face: "bar" as const };

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

/** More fields than the card shows: the first few, and how many the full request holds besides. */
export const ManyFields = meta.story({
	args: {
		call: pending({
			tool: "linear__update_issue",
			input: {
				issueId: "NIT-1846",
				title: "Investigate and resolve slow initial chat history load time",
				state: "In Progress",
				priority: "High",
				assignee: "tim.holm@nitric.io",
				estimate: 5,
				cycle: "Cycle 33",
				project: "Internal Agents",
				dueDate: "2026-10-02",
			},
		}),
	},
});

/** Values with structure inside: a list of plain values reads as itself, anything bigger as a count. */
export const StructuredValues = meta.story({
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
});

/** A request that is not a record of named fields: said in brief like any other value. */
export const NotARecord = meta.story({
	args: {
		call: pending({
			tool: "linear__create_issues",
			input: Array.from({ length: 60 }, (_, index) => ({ title: `Issue ${index}`, state: "todo" })),
		}),
	},
});

/** A list of same-shaped records, written out as a table with its fields named once. */
export const AListOfRecordsOpened = meta.story({
	args: NotARecord.input.args,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /View full request/ }));
	},
});

/** The whole request, written out in a dialog that scrolls rather than stretching the thread. */
export const TheFullRequestOpened = meta.story({
	args: StructuredValues.input.args,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /View full request/ }));
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
		return <DeniedToolLine call={denied} agent={agent} look={look} />;
	},
});

/** Reviewing a refusal: the request as it was put, and who refused it where the answer was. */
export const ADenialReviewed = meta.story({
	render: AfterDenying.input.render,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
	},
});
