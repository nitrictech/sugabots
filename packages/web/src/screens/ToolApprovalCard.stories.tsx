import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, screen } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

const PHONE = { viewport: { value: "galaxys9", isRotated: false } };

const calendar: ConnectionLook = { name: "Google Calendar" };
const linear: ConnectionLook = { name: "Linear", presetId: "linear" };

const tripPlanner = { name: "Trip Planner", color: "sky" as const, face: "dot" as const };
const growthDesk = { name: "Growth Desk", color: "green" as const, face: "pill" as const };

function asking(over: Partial<ToolCallPart> = {}): ToolCallPart {
	return {
		type: "tool_call",
		id: "0199a3a0-0000-7000-8000-000000000001",
		tool: "google_calendar__create_event",
		input: {
			calendar: "Family",
			title: "Flights to Lisbon",
			when: "Fri 14 Nov, 07:40 to 10:15",
			guests: "ryan@nitric.io, mia@nitric.io, sam@nitric.io",
			where: "TAP 1351, London Heathrow T2 to Lisbon T1",
			notes: "Booking ref QX7R2P. Seats 14A to 14C. Check in opens 24 hours before.",
			reminder: "3 hours before",
		},
		output: null,
		status: "awaiting_approval",
		error: null,
		mutating: true,
		atOffset: 0,
		startedAt: "2026-11-10T09:00:00.000Z",
		finishedAt: null,
		approval: { status: "pending", decidedByName: null, decidedAt: null },
		...over,
	};
}

const bigLinearIssue = asking({
	tool: "linear__create_issue",
	input: {
		team: "Platform",
		title: "Checkout times out at the 30s gateway limit on POST /checkout",
		priority: "Urgent",
		labels: ["bug", "payments", "customer-reported"],
		assignee: "Unassigned",
		project: "Q4 reliability",
		description:
			"41 events in the last 24 hours, all on POST /checkout, all hitting the 30s gateway limit. Started at 02:14 UTC, just after the 0.18.2 deploy.\n\nWhat we see\n• p95 latency on /checkout went from 1.2s to 28.4s\n• Every timeout is a cart with more than 20 items\n• The inventory reservation call is retried 6 times before giving up\n\nCustomers affected\nNorthwind (3 failed orders), Acme Retail (11), Globex (2). Two of them have opened support tickets.\n\nLikely cause\nThe batch reservation change in 0.18.2 reserves items one by one instead of in a single call. Reverting it in staging brings p95 back to 1.4s.\n\nSuggested fix\nRevert the change, or restore the batched call behind a flag and add a timeout of 10s on the reservation step.\n\nSentry: PLAT-482, PLAT-487\nRaised by Growth Desk from the Revenue pod.",
	},
});

const decided = (status: "allowed" | "denied", by: string) =>
	asking({
		approval: {
			status,
			decidedByName: by,
			decidedAt: "2026-11-10T09:02:00.000Z",
		},
	});

const meta = preview.meta({
	title: "Product/ToolApprovalCard",
	component: ToolApprovalCard,
	tags: ["ai-generated"],
	args: {
		call: asking(),
		agent: tripPlanner,
		threadId: "0199a3a0-0000-7000-8000-0000000000b2",
		podId: "0199a3a0-0000-7000-8000-0000000000b1",
		canApprove: true,
		look: calendar,
	},
	decorators: [
		function WithQueries(Story) {
			const [queryClient] = useState(
				() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
			);
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="mx-auto max-w-[560px] py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/** WaitingOnYou is a bot's write held for an answer: who wants to use what, the request folded, then Allow or Deny. */
export const WaitingOnYou = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Trip Planner wants to use Google Calendar")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: /^Deny/ })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "See more" })).toBeInTheDocument();
	},
});

/** RequestUnfolded is the whole request read in the card, scrolling inside it past a cap. */
export const RequestUnfolded = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "See more" }));
		await expect(canvas.getByRole("button", { name: "See less" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	},
});

/** ViewerCantAnswer is the request seen by someone without permission to answer it. */
export const ViewerCantAnswer = meta.story({
	args: { canApprove: false },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Waiting for someone with permission to answer this."),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** Answered keeps the request readable after the answer, and says under it how it went and who answered. */
export const Answered = meta.story({
	args: { call: decided("allowed", "Ryan") },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** BigLinearIssueFolded is a long write folded in the card, so it never takes over the thread. */
export const BigLinearIssueFolded = meta.story({
	args: { call: bigLinearIssue, agent: growthDesk, look: linear },
});

/** BigLinearIssueUnfolded scrolls inside the card, stopping at its ends rather than scrolling the chat. */
export const BigLinearIssueUnfolded = meta.story({
	args: { call: bigLinearIssue, agent: growthDesk, look: linear },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "See more" }));
	},
});

/** ConnectionSinceRemoved is a call to a connection the pod no longer has: the handle is written out. */
export const ConnectionSinceRemoved = meta.story({ args: { look: undefined } });

/** OnAPhone shows the start of the request and one Review button, which opens it full screen. */
export const OnAPhone = meta.story({
	globals: PHONE,
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Review" })).toBeInTheDocument();
	},
});

/** OnAPhoneInLight is the same card in the light theme. */
export const OnAPhoneInLight = meta.story({ globals: { ...PHONE, theme: "light" } });

/** ReviewOnAPhone is the whole request full screen, with Close at its top right and Deny and Allow pinned under it. */
export const ReviewOnAPhone = meta.story({
	globals: PHONE,
	args: { call: bigLinearIssue, agent: growthDesk, look: linear },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Create issue" });
		await expect(request).toBeInTheDocument();
		await expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		await expect(screen.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
	},
});

/** ReviewOnAPhoneAsAViewer opens the request to read, saying it waits on someone with permission where the buttons would be. */
export const ReviewOnAPhoneAsAViewer = meta.story({
	globals: PHONE,
	args: { canApprove: false },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "See request" }));
		await expect(await screen.findByRole("dialog", { name: "Create event" })).toBeInTheDocument();
	},
});

/** ANetworkRequest is an agent asking for its pod's sandbox to reach a host, which an admin of the pod answers. */
export const ANetworkRequest = meta.story({
	args: {
		call: asking({
			tool: "request_network_access",
			input: {
				host: "api.stripe.com",
			},
			approval: {
				status: "pending",
				deciders: "sandbox-managers",
				decidedByName: null,
				decidedAt: null,
			},
		}),
		look: undefined,
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Trip Planner wants its sandbox to reach a new host"),
		).toBeInTheDocument();
		await expect(canvas.queryByText("RN")).toBeNull();
	},
});

/** ANetworkRequestNotYours is that request seen by someone who doesn't decide the pod's network access. */
export const ANetworkRequestNotYours = meta.story({
	args: { ...ANetworkRequest.input.args, canApprove: false },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Waiting for an admin of this pod to answer this."),
		).toBeInTheDocument();
	},
});

/** ASoftwareRequest is an agent asking for a package to be installed in its pod's sandbox, which an admin of the pod answers. */
export const ASoftwareRequest = meta.story({
	args: {
		...ANetworkRequest.input.args,
		call: {
			...ANetworkRequest.input.args.call,
			tool: "request_software",
			input: { name: "ffmpeg" },
		},
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Trip Planner wants to install software in its sandbox"),
		).toBeInTheDocument();
	},
});
