import type {
	AnsweredApproval,
	ApprovalInbox,
	ApprovalRequest,
	ToolCallPart,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyChatFor, storyWorkspace } from "@/story-app.tsx";

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
	return {
		call: {
			type: "tool_call",
			id: `0199a3a0-0000-7000-8000-0000000008${id}`,
			tool: "stripe__send_quote",
			input: { customer: "Acme Retail", plan: "Annual tier", total: "$43,200 a year" },
			output: null,
			status,
			error: null,
			mutating: true,
			atOffset: 0,
			startedAt: ASKED_AT,
			finishedAt: null,
			approval,
		},
		agent: {
			kind: "agent",
			id: growthDesk.id,
			name: growthDesk.name,
			handle: growthDesk.handle,
			color: growthDesk.color,
			face: growthDesk.face,
		},
		podId: revenue.id,
		threadId: storyChatFor(growthDesk).mainThreadId,
		chatAgentId: growthDesk.id,
		inMainThread: true,
	};
}

const pending = { status: "pending", decidedByName: null, decidedAt: null } as const;
const denied = {
	status: "denied",
	decidedByName: "Ryan Eyes",
	decidedAt: "2026-09-18T09:04:00.000Z",
} as const;
const answerable = request("01", "awaiting_approval", pending);
const stopped = request("02", "failed", pending);
const answered: AnsweredApproval = { ...request("03", "failed", denied), answer: denied };

const inbox: ApprovalInbox = { waiting: [answerable, stopped], answered: [answered] };

const meta = preview.meta({
	title: "Views/ApprovalPage",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () => HttpResponse.json(inbox)),
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
		await expect(
			await canvas.findByRole("button", { name: /^Allow/ }, { timeout: 10_000 }),
		).toBeEnabled();
		await expect(canvas.getByRole("button", { name: /^Deny/ })).toBeEnabled();
	},
});

/** Answered says which way it went, who answered it, and when, with no way to answer again. */
export const Answered = meta.story({
	render: at(answered.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/Denied by Ryan Eyes/, undefined, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** NoLongerWaiting is a request whose bot stopped before anyone answered it: nothing to answer. */
export const NoLongerWaiting = meta.story({
	render: at(stopped.call.id),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/No longer waiting/, undefined, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: /^Allow/ })).toBeNull();
	},
});

/** Missing is a request the inbox no longer holds, such as one answered long ago. */
export const Missing = meta.story({
	render: at("0199a3a0-0000-7000-8000-000000000899"),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("This request is no longer here", undefined, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});
