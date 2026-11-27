import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useEffect, useState } from "react";
import { expect, screen, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import type { MarkedConnector } from "@/lib/connectors.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

const PHONE = { viewport: { value: "galaxys9", isRotated: false } };

const calendar: MarkedConnector = { name: "Google Calendar" };
const linear: MarkedConnector = { name: "Linear", markId: "linear" };

const tripPlanner = {
	name: "Trip Planner",
	color: "sky" as const,
	eyes: "dot" as const,
	shape: "circle" as const,
};
const growthDesk = {
	name: "Growth Desk",
	color: "green" as const,
	eyes: "pill" as const,
	shape: "circle" as const,
};

function asking(over: Partial<ToolCallPart> = {}): ToolCallPart {
	return {
		type: "tool_call",
		id: "0199a3a0-0000-7000-8000-000000000001",
		tool: "google_calendar__create_event",
		input: {
			calendar: "Family",
			title: "Flights to Lisbon",
			when: "Fri 14 Nov, 07:40 to 10:15",
			guests: "rowan@example.com, mia@nitric.io, sam@nitric.io",
			where: "TAP 1351, London Heathrow T2 to Lisbon T1",
			notes: "Booking ref QX7R2P. Seats 14A to 14C. Check in opens 24 hours before.",
			reminder: "3 hours before",
		},
		output: null,
		status: "awaiting_approval",
		error: null,
		atOffset: 0,
		startedAt: "2026-11-10T09:00:00.000Z",
		finishedAt: null,
		approval: {
			id: "approval-1",
			status: "pending",
			approvers: "chat",
			decidedByName: null,
			decidedAt: null,
		},
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
			"41 events in the last 24 hours, all on POST /checkout, all hitting the 30s gateway limit. Started at 02:14 UTC, just after the 0.18.2 deploy.\n\nWhat we see\n• p95 latency on /checkout went from 1.2s to 28.4s\n• Every timeout is a cart with more than 20 items\n• The inventory reservation call is retried 6 times before giving up\n\nCustomers affected\nNorthwind (3 failed orders), Acme Retail (11), Globex (2). Two of them have opened support tickets.\n\nLikely cause\nThe batch reservation change in 0.18.2 reserves items one by one instead of in a single call. Reverting it in staging brings p95 back to 1.4s.\n\nSuggested fix\nRevert the change, or restore the batched call behind a flag and add a timeout of 10s on the reservation step.\n\nSentry: PLAT-482, PLAT-487\nRaised by Growth Desk from the Revenue project.",
	},
});

const decided = (status: "allowed" | "denied", by: string) =>
	asking({
		approval: {
			id: "approval-1",
			status,
			approvers: "chat",
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
		bot: tripPlanner,
		chatId: "0199a3a0-0000-7000-8000-0000000000b2",
		canApprove: true,
		connector: calendar,
	},
	decorators: [
		function WithQueries(Story) {
			const [queryClient] = useState(
				() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
			);
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="mx-auto max-w-xl py-4">
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
	args: { call: decided("allowed", "Rowan") },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

const connectorClosedReason =
	"This approval was closed because the connector or its tool settings changed.";

/** A connector changes before Allow, and the chat receives the closed request. */
export const ClosedAfterAllow = meta.story({
	globals: PHONE,
	loaders: [() => ({ closedCall: Promise.withResolvers<ToolCallPart>() })],
	beforeEach({ msw, args }) {
		msw.use(
			http.post(`${import.meta.env.VITE_API_URL}/tool-calls/${args.call.id}/approval`, () =>
				HttpResponse.json({ _tag: "Conflict", message: connectorClosedReason }, { status: 409 }),
			),
		);
	},
	render: function ClosedAfterAllowCard(args, { loaded }) {
		const [call, setCall] = useState(args.call);
		useEffect(() => {
			void loaded.closedCall.promise.then(setCall);
		}, [loaded.closedCall]);
		return <ToolApprovalCard {...args} call={call} />;
	},
	play: async ({ canvas, args, loaded, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Create event" });
		await userEvent.click(screen.getByRole("button", { name: "Allow: Create event" }));
		await expect(await screen.findByRole("alert")).toHaveTextContent(connectorClosedReason);
		loaded.closedCall.resolve(
			asking({
				...args.call,
				status: "failed",
				error: connectorClosedReason,
				finishedAt: "2026-11-10T09:02:00.000Z",
				approval: args.call.approval && {
					...args.call.approval,
					status: "denied",
					closedBecause: "connectorChanged",
				},
			}),
		);
		const outcome = `${connectorClosedReason} Ask Trip Planner to try again.`;
		await waitFor(() => expect(request).toHaveTextContent(outcome));
		await expect(screen.queryByRole("button", { name: "Allow: Create event" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		await expect(await canvas.findByText(outcome)).toBeVisible();
	},
});

const connectorUnavailableMessage = "We couldn't reach the connector. Try Allow again shortly.";

export const ConnectorUnavailableOnAllow = meta.story({
	globals: { ...PHONE, theme: "dark" },
	parameters: {
		docs: { description: { story: "Allow can be tried again from the request on a phone." } },
	},
	beforeEach({ msw, args }) {
		msw.use(
			http.post(`${import.meta.env.VITE_API_URL}/tool-calls/${args.call.id}/approval`, () =>
				HttpResponse.json(
					{
						_tag: "ServiceUnavailable",
						message: connectorUnavailableMessage,
					},
					{ status: 503 },
				),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Create event" });
		await userEvent.click(screen.getByRole("button", { name: "Allow: Create event" }));
		await expect(await screen.findByRole("alert")).toHaveTextContent(connectorUnavailableMessage);
		await waitFor(() => expect(request).toBeVisible());
		await expect(screen.getByRole("button", { name: "Allow: Create event" })).toBeEnabled();
		await expect(screen.getByRole("button", { name: "Deny: Create event" })).toBeEnabled();
	},
});

/** WithdrawnAfterNewMessage shows a request the bot left behind when a new message arrived. */
export const WithdrawnAfterNewMessage = meta.story({
	globals: PHONE,
	args: {
		call: asking({
			status: "failed",
			error: "Withdrawn: a new message reached the bot before this was decided",
			finishedAt: "2026-11-10T09:02:00.000Z",
			approval: {
				id: "approval-1",
				status: "denied",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				closedBecause: "newMessage",
			},
		}),
	},
	play: async ({ canvas, userEvent }) => {
		const outcome = "No longer waiting. A new message reached Trip Planner.";
		await waitFor(() => expect(canvas.getByText(outcome)).toBeVisible());
		await userEvent.click(canvas.getByRole("button", { name: "See request" }));
		const request = await screen.findByRole("dialog", { name: "Create event" });
		await expect(request).toHaveTextContent(outcome);
		await expect(request).not.toHaveTextContent("try again");
		await expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

export const Expired = meta.story({
	globals: { ...PHONE, theme: "dark" },
	parameters: { docs: { description: { story: "Nobody answered within seven days." } } },
	args: {
		call: asking({
			status: "failed",
			finishedAt: "2026-11-17T09:00:00.000Z",
			approval: {
				id: "approval-1",
				status: "denied",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				closedBecause: "approvalExpired",
			},
		}),
	},
	play: async ({ canvas }) => {
		const outcome =
			"No longer waiting. Nobody answered within 7 days. Ask Trip Planner to try again.";
		await waitFor(() => expect(canvas.getByText(outcome)).toBeVisible());
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** BigLinearIssueFolded is a long write folded in the card, so it never takes over the chat. */
export const BigLinearIssueFolded = meta.story({
	args: { call: bigLinearIssue, bot: growthDesk, connector: linear },
});

/** BigLinearIssueUnfolded scrolls inside the card, stopping at its ends rather than scrolling the chat. */
export const BigLinearIssueUnfolded = meta.story({
	args: { call: bigLinearIssue, bot: growthDesk, connector: linear },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "See more" }));
	},
});

/** ConnectorSinceRemoved is a call to a connector the bot no longer has: the handle is written out. */
export const ConnectorSinceRemoved = meta.story({ args: { connector: undefined } });

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
	args: { call: bigLinearIssue, bot: growthDesk, connector: linear },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Create issue" });
		await expect(request).toBeInTheDocument();
		await expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		await expect(screen.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
	},
});

/** ListEntryBoundaries keeps a comma inside a label readable in the compact request. */
export const ListEntryBoundaries = meta.story({
	args: {
		call: asking({
			tool: "linear__update_issue",
			input: { current_labels: ["North, West"], next_labels: ["North", "West"] },
		}),
		connector: linear,
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText('["North, West"]')).toBeInTheDocument();
		await expect(canvas.getByText('["North","West"]')).toBeInTheDocument();
	},
});

/** ExactInput distinguishes values that have the same compact label. */
export const ExactInput = meta.story({
	globals: { ...PHONE, theme: "light" },
	args: {
		call: asking({
			tool: "linear__update_issue",
			input: { before: { assignee: null }, after: { assignee: "" } },
		}),
		connector: linear,
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Update issue" });
		await expect(request).toHaveTextContent('"assignee": null');
		await expect(request).toHaveTextContent('"assignee": ""');
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

/** BrowserPage shows the address of the tab the bot wants to click in. */
export const BrowserPage = meta.story({
	globals: PHONE,
	args: {
		call: asking({
			tool: "browser_click",
			input: { target: "Submit order" },
			approval: {
				id: "approval-1",
				status: "pending",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				browserUrl: "https://travel.example.com/checkout",
			},
		}),
		connector: undefined,
	},
	play: async ({ canvas, userEvent }) => {
		await waitFor(() =>
			expect(canvas.getByText("On the page https://travel.example.com/checkout")).toBeVisible(),
		);
		await expect(
			canvas.getByText(
				"Allowing this lets Trip Planner act anywhere on this page, which may change before you decide.",
			),
		).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog");
		await expect(request).toHaveTextContent("On the page https://travel.example.com/checkout");
		await expect(request).toHaveTextContent(
			"Allowing this lets Trip Planner act anywhere on this page, which may change before you decide.",
		);
	},
});

/** AnsweredBrowserPage is a browser request already answered: its full view no longer says the page may change before you decide. */
export const AnsweredBrowserPage = meta.story({
	globals: PHONE,
	args: {
		call: asking({
			tool: "browser_click",
			input: { target: "Submit order" },
			status: "completed",
			approval: {
				id: "approval-1",
				status: "allowed",
				approvers: "chat",
				decidedByName: "Rowan",
				decidedAt: "2026-11-10T09:02:00.000Z",
				browserUrl: "https://travel.example.com/checkout",
			},
		}),
		connector: undefined,
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "See request" }));
		const request = await screen.findByRole("dialog");
		await expect(request).toHaveTextContent("On the page https://travel.example.com/checkout");
		await expect(request).not.toHaveTextContent("may change before you decide");
	},
});

/** GitHubReviewCommit is a review the bot didn't pin to a commit: the card shows the commit it will review. */
export const GitHubReviewCommit = meta.story({
	globals: PHONE,
	args: {
		call: asking({
			tool: "github__review_pull_request",
			input: { repository: "acme/web", pullRequest: 42, verdict: "approve", body: "Looks good." },
			approval: {
				id: "approval-1",
				status: "pending",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				gitHub: { repositoryId: "101", reviewCommit: "3f2c9a1b7e4d" },
			},
		}),
		connector: { name: "GitHub" },
	},
	play: async ({ canvas }) => {
		await waitFor(() => expect(canvas.getByText("Reviews commit 3f2c9a1")).toBeVisible());
	},
});

/** GitHubDefaultBase is a pull request the bot didn't name a base for: the card shows the branch it will use. */
export const GitHubDefaultBase = meta.story({
	globals: PHONE,
	args: {
		call: asking({
			tool: "github__open_pull_request",
			input: {
				repository: "acme/web",
				branch: "sugabots/fix-checkout",
				title: "Fix checkout",
				body: "Keep the order after a refresh.",
			},
			approval: {
				id: "approval-1",
				status: "pending",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				gitHub: { repositoryId: "101", baseBranch: "release" },
			},
		}),
		connector: { name: "GitHub" },
	},
	play: async ({ canvas, userEvent }) => {
		await waitFor(() => expect(canvas.getByText("Base branch release")).toBeVisible());
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog");
		await expect(request).toHaveTextContent("Base branch release");
	},
});

/** ANetworkRequest is a bot asking for the project's computer to reach a host, which those who manage the computer answer. */
export const ANetworkRequest = meta.story({
	args: {
		call: asking({
			tool: "request_host",
			input: {
				host: "api.stripe.com",
			},
			approval: {
				id: "approval-1",
				status: "pending",
				approvers: "computer-managers",
				decidedByName: null,
				decidedAt: null,
			},
		}),
		connector: undefined,
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Trip Planner wants the project's computer to reach a new host"),
		).toBeInTheDocument();
		await expect(canvas.queryByText("RN")).toBeNull();
	},
});

/** ANetworkRequestNotYours is that request seen by someone who doesn't manage the computer it would change. */
export const ANetworkRequestNotYours = meta.story({
	args: { ...ANetworkRequest.input.args, canApprove: false },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText(
				"The workspace's owner or an admin can decide. In a bot's own chats, whoever made the bot can too.",
			),
		).toBeInTheDocument();
	},
});

/** The brief names the destination before the asker shares its contents. */
export const BriefInProject = meta.story({
	args: {
		call: asking({
			tool: "start_chat",
			input: { with: "@ada", title: "Launch notes", brief: "Draft the release notes." },
			approval: {
				id: "approval-brief",
				status: "pending",
				approvers: "chat",
				decidedByName: null,
				decidedAt: null,
				briefDestination: { botName: "Ada", projectName: "Launch" },
			},
		}),
		connector: undefined,
	},
	globals: { ...PHONE, theme: "light" },
	play: async ({ canvas, userEvent }) => {
		const destination = "Starts a chat with Ada in Launch";
		await waitFor(() => expect(canvas.getByText(destination)).toBeVisible());
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		await expect(await screen.findByRole("dialog")).toHaveTextContent(destination);
	},
});

const askingToChangeRoutine = (routineChange: "add" | "replace") =>
	asking({
		tool: "update_automation",
		input: {
			automationId: "0199a3a0-0000-7000-8000-000000000007",
			routineExpression: "0 9 * * 1-5",
		},
		approval: {
			id: "approval-routine",
			status: "pending",
			approvers: "chat",
			decidedAt: null,
			decidedByName: null,
			routineChange,
		},
	});

export const AddFirstRoutine = meta.story({
	parameters: { docs: { description: { story: "The automation has no routine yet." } } },
	args: {
		call: askingToChangeRoutine("add"),
		connector: undefined,
	},
	globals: { theme: "light" },
	play: async ({ canvas }) => {
		await waitFor(() =>
			expect(canvas.getByText("Adds the automation's first routine.")).toBeVisible(),
		);
	},
});

export const ReplaceRoutineOnPhone = meta.story({
	parameters: {
		docs: { description: { story: "The edit replaces the automation's only routine." } },
	},
	args: {
		call: askingToChangeRoutine("replace"),
		connector: undefined,
	},
	globals: { ...PHONE, theme: "dark" },
	play: async ({ canvas, userEvent }) => {
		const message = "Replaces the automation's existing routine.";
		await waitFor(() => expect(canvas.getByText(message)).toBeVisible());
		await userEvent.click(canvas.getByRole("button", { name: "Review" }));
		await expect(await screen.findByRole("dialog")).toHaveTextContent(message);
	},
});
