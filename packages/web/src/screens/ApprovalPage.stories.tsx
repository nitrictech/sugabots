import type {
	AnsweredApproval,
	ApprovalRequest,
	ProjectBotConnector,
	ToolCallPart,
	WorkspaceApprovals,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { storyApproval } from "@/shell/approval-story.test-support.ts";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

/*
 * One approval request in full, beside the Approvals list: what it would do,
 * every field, and Allow and Deny, or how it was answered, or why it no
 * longer can be.
 */

const API = import.meta.env.VITE_API_URL as string;

const ASKED_AT = "2026-09-18T09:00:00.000Z";

function request(
	id: string,
	status: ToolCallPart["status"],
	approval: ToolCallPart["approval"],
): ApprovalRequest {
	return storyApproval({
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-0000000008${id}`,
		tool: "stripe__send_quote",
		input: { customer: "Acme Retail", plan: "Annual tier", total: "$43,200 a year" },
		output: null,
		status,
		error: null,
		atOffset: 0,
		startedAt: ASKED_AT,
		finishedAt: null,
		approval,
	});
}

const pending = {
	id: "approval-1",
	status: "pending",
	approvers: "chat",
	decidedByName: null,
	decidedAt: null,
} as const;
const denied = {
	id: "approval-1",
	status: "denied",
	approvers: "chat",
	decidedByName: "Rowan Ellis",
	decidedAt: "2026-09-18T09:04:00.000Z",
} as const;
const botConnector: ProjectBotConnector = {
	id: "0199a3a0-0000-7000-8000-000000000820",
	name: "Growth Desk Billing",
	url: "https://billing.example.com/mcp",
	kind: "mcp",
	addressRevision: 1,
	configurationRevision: 2,
	botId: growthDesk.id,
	on: true,
	addressChanged: false,
};
const answerable = request("01", "awaiting_approval", {
	...pending,
	connector: { id: botConnector.id, revision: 2 },
});
const closedAt = "2026-09-18T09:04:00.000Z";
const stoppedRequest = request("02", "failed", {
	...pending,
	status: "denied",
	closedBecause: "botStopped",
});
const stopped: AnsweredApproval = {
	...stoppedRequest,
	call: { ...stoppedRequest.call, error: "Turn interrupted", finishedAt: closedAt },
	answer: { status: "closed", closedAt },
};
const answered: AnsweredApproval = { ...request("03", "failed", denied), answer: denied };
const changedBriefBase = request("07", "awaiting_approval", pending);
const changedBrief: ApprovalRequest = {
	...changedBriefBase,
	call: {
		...changedBriefBase.call,
		tool: "start_chat",
		input: { title: "Draft the report", brief: "Summarize the launch.", with: "@report-writer" },
	},
};
const briefClosedReason =
	"This approval was closed because the chat the bot wanted to start changed.";
const closedBrief: AnsweredApproval = {
	...changedBrief,
	call: {
		...changedBrief.call,
		status: "failed",
		finishedAt: closedAt,
		approval: { ...pending, status: "denied", closedBecause: "briefDestinationChanged" },
	},
	answer: { status: "closed", closedAt },
};

const hostApproval = request("04", "awaiting_approval", pending);
const outside = {
	...hostApproval,
	projectName: revenue.name,
	chatId: null,
	rootChatId: null,
	call: {
		...hostApproval.call,
		tool: "request_host",
		input: { host: "api.acme.example" },
		approval: { ...pending, approvers: "computer-managers" },
	},
} satisfies ApprovalRequest;
const unavailable: AnsweredApproval = {
	...outside,
	call: {
		...outside.call,
		id: "0199a3a0-0000-7000-8000-000000000808",
		status: "failed",
		finishedAt: closedAt,
		approval: {
			...outside.call.approval,
			status: "denied",
			closedBecause: "chatUnavailable",
		},
	},
	answer: { status: "closed", closedAt },
};
const blockedHostRequest = request("09", "failed", {
	...pending,
	status: "denied",
	closedBecause: "hostBlocked",
});
const blockedHost: AnsweredApproval = {
	...blockedHostRequest,
	call: {
		...blockedHostRequest.call,
		tool: "request_host",
		input: { host: "api.acme.example" },
		finishedAt: closedAt,
	},
	answer: { status: "closed", closedAt },
};
const switchedOffConnectorRequest = request("10", "failed", {
	...pending,
	status: "denied",
	closedBecause: "connectorOff",
	connector: { id: botConnector.id, revision: 2 },
});
const switchedOffConnector: AnsweredApproval = {
	...switchedOffConnectorRequest,
	call: { ...switchedOffConnectorRequest.call, finishedAt: closedAt },
	answer: { status: "closed", closedAt },
};
const withoutFields = {
	...outside,
	call: { ...outside.call, id: "0199a3a0-0000-7000-8000-000000000805", input: null },
};

const briefRequest = request("06", "awaiting_approval", pending);
const brief: ApprovalRequest = {
	...briefRequest,
	call: {
		...briefRequest.call,
		tool: "start_chat",
		input: { with: "@ada", title: "Launch notes", brief: "Draft the release notes." },
		approval: { ...pending, briefDestination: { botName: "Ada", projectName: null } },
	},
};

const approvals: WorkspaceApprovals = {
	waiting: [answerable, outside, withoutFields, brief],
	answered: [answered, stopped, closedBrief, unavailable, blockedHost, switchedOffConnector],
};

const meta = preview.meta({
	title: "Views/ApprovalPage",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () => HttpResponse.json(approvals)),
			http.get(`${API}/projects/${revenue.id}/bot-connectors`, () =>
				HttpResponse.json([botConnector]),
			),
			...appHandlers(),
		);
	},
});

const at = (callId: string) => () => (
	<StoryApp path={`/${storyWorkspace.slug}/approvals/${callId}`} />
);

/** Answerable waits on you: every field of the request, then Allow and Deny. */
export const Answerable = meta.story({
	render: at(answerable.call.id),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: /^Allow/ })).toBeEnabled();
		await expect(canvas.getByRole("button", { name: /^Deny/ })).toBeEnabled();
		await expect(
			await canvas.findByText("Growth Desk wants to use Growth Desk Billing"),
		).toBeVisible();
		await expect(canvas.getByText("Sends to https://billing.example.com/mcp")).toBeVisible();
	},
});

/** Answered says which way it went, who answered it, and when, with no way to answer again. */
export const Answered = meta.story({
	render: at(answered.call.id),
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/Denied by Rowan Ellis/, undefined)).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** A changed brief closes on Allow, and the reason stays visible on the request and in Approvals. */
export const ClosedAfterAllow = meta.story({
	globals: { theme: "light" },
	render: at(changedBrief.call.id),
	loaders: [() => ({ closedRequest: Promise.withResolvers<void>() })],
	beforeEach({ msw, loaded }) {
		let closed = false;
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, async () => {
				if (!closed) return HttpResponse.json({ waiting: [changedBrief], answered: [] });
				await loaded.closedRequest.promise;
				return HttpResponse.json({ waiting: [], answered: [closedBrief] });
			}),
			http.post(`${API}/tool-calls/${changedBrief.call.id}/approval`, () => {
				closed = true;
				return HttpResponse.json({ _tag: "Conflict", message: briefClosedReason }, { status: 409 });
			}),
		);
	},
	play: async ({ canvas, loaded, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: /^Allow/ }));
		try {
			await expect(await canvas.findByRole("alert")).toHaveTextContent(briefClosedReason);
		} finally {
			loaded.closedRequest.resolve();
		}
		const outcome =
			"This approval was closed because the chat Growth Desk wanted to start changed. Ask Growth Desk to try again.";
		await expect(await canvas.findByText(outcome)).toBeVisible();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
		await expect(canvas.getByRole("link", { name: "Open chat" })).toBeVisible();
		await userEvent.click(canvas.getByRole("link", { name: "Back to Approvals" }));
		await expect(await canvas.findByText(outcome)).toBeVisible();
	},
});

/** NoLongerWaiting shows a request after someone stopped the bot. */
export const NoLongerWaiting = meta.story({
	render: at(stopped.call.id),
	play: async ({ canvas, userEvent }) => {
		const outcome = "No longer waiting. Growth Desk was stopped.";
		await expect(await canvas.findByText(outcome)).toBeVisible();
		await expect(canvas.queryByText(/try again/)).toBeNull();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
		await expect(await canvas.findByRole("link", { name: "Open chat" })).toBeVisible();
		await userEvent.click(canvas.getByRole("link", { name: "Back to Approvals" }));
		const row = await canvas.findByRole("link", { name: /Send quote.*No longer waiting/ });
		await expect(row).not.toHaveTextContent("try again");
	},
});

/** SettingsChanged keeps the reason and a way back to the chat when a brief changed before Allow. */
export const SettingsChanged = meta.story({
	render: at(closedBrief.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"This approval was closed because the chat Growth Desk wanted to start changed. Ask Growth Desk to try again.",
			),
		).toBeVisible();
		await expect(await canvas.findByRole("link", { name: "Open chat" })).toBeVisible();
	},
});

export const ChatUnavailable = meta.story({
	globals: { theme: "light", viewport: { value: "galaxys9", isRotated: false } },
	parameters: {
		docs: { description: { story: "The approval closed when its chat became unavailable." } },
	},
	render: at(unavailable.call.id),
	play: async ({ canvas, userEvent }) => {
		const outcome =
			"No longer waiting. This chat is no longer available. If you can still talk to Growth Desk, start a new chat.";
		await expect(await canvas.findByText(outcome)).toBeVisible();
		await expect(canvas.queryByRole("link", { name: "Open chat" })).toBeNull();
		await userEvent.click(canvas.getByRole("link", { name: "Back to Approvals" }));
		await expect(await canvas.findByText(outcome)).toBeVisible();
	},
});

/** Computer managers can see the fixed host when they cannot reach the chat. */
export const OutsideTheChat = meta.story({
	render: at(outside.call.id),
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/"host": "api.acme.example"/)).toBeVisible();
		await expect(
			canvas.getByText(/Growth Desk wants the project's computer to reach a new host/),
		).toBeVisible();
		await expect(canvas.queryByRole("link", { name: "Open chat" })).toBeNull();
	},
});

/** Some approvals have no fields to show outside the chat. */
export const OutsideTheChatWithoutFields = meta.story({
	render: at(withoutFields.call.id),
	play: async ({ canvas }) => {
		const request = await canvas.findByRole("article", { name: "Approval request: Request host" });
		const approval = within(request);
		await expect(request.querySelector("dl")).toBeNull();
		await expect(approval.queryByRole("link", { name: "Open chat" })).toBeNull();
		await expect(approval.getByRole("button", { name: "Allow: Request host" })).toBeEnabled();
		await expect(approval.getByRole("button", { name: "Deny: Request host" })).toBeEnabled();
	},
});

/** Missing is a request the approvals no longer list, such as one answered long ago. */
export const Missing = meta.story({
	render: at("0199a3a0-0000-7000-8000-000000000899"),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("This request is no longer here", undefined),
		).toBeInTheDocument();
	},
});

/** A brief can start a chat in the recipient bot's own chats. */
export const BriefInBotsOwnChats = meta.story({
	render: at(brief.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("Starts a chat with Ada in Ada's own chats"),
		).toBeVisible();
	},
});

/** SettingBlocksRetry names who can change the setting instead of asking the bot to try again. */
export const SettingBlocksRetry = meta.story({
	render: at(blockedHost.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"This approval was closed because the workspace now blocks the requested host. The workspace's owner or an admin can unblock it.",
			),
		).toBeVisible();
		await expect(canvas.queryByText(/try again/)).toBeNull();
	},
});

/** ConnectorSwitchedOff shows who can turn a connector or its tool back on. */
export const ConnectorSwitchedOff = meta.story({
	render: at(switchedOffConnector.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				/The workspace's owner or an admin can turn a connector back on for a project/,
			),
		).toHaveTextContent(
			"whoever manages the connector can change its access in the connector's settings",
		);
		await expect(canvas.queryByText(/try again/)).toBeNull();
	},
});
