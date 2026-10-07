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
 * Every approval across the workspace, opened from the rail: what waits on
 * you, each answerable here, and the latest answered.
 */

const API = import.meta.env.VITE_API_URL as string;

function call(id: string, tool: string, approval: ToolCallPart["approval"]): ToolCallPart {
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-0000000007${id}`,
		tool,
		input: {
			customer: "Acme Retail",
			plan: "Annual tier",
			discount: "25%, over the 20% cap",
			total: "$43,200 a year",
		},
		output: null,
		status: approval?.status === "pending" ? "awaiting_approval" : "completed",
		error: null,
		mutating: true,
		atOffset: 0,
		startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
		finishedAt: null,
		approval,
	};
}

function request(id: string, tool: string, approval: ToolCallPart["approval"]): ApprovalRequest {
	return {
		call: call(id, tool, approval),
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

function answered(id: string, tool: string, answer: AnsweredApproval["answer"]): AnsweredApproval {
	return { ...request(id, tool, answer), answer };
}

const inbox: ApprovalInbox = {
	waiting: [
		request("01", "stripe__send_quote", {
			status: "pending",
			decidedByName: null,
			decidedAt: null,
		}),
	],
	answered: [
		answered("02", "gmail__send_email", {
			status: "allowed",
			decidedByName: "Ryan Eyes",
			decidedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		}),
		answered("03", "hubspot__delete_deal", {
			status: "denied",
			decidedByName: "Ryan Eyes",
			decidedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
		}),
	],
};

const meta = preview.meta({
	title: "Views/Approvals",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () => HttpResponse.json(inbox)),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/approvals`} />,
});

/** A request waiting on you, beside an empty pane until one is chosen; the answered ones are under their own tab. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: /Send quote/ }, { timeout: 10_000 }),
		).toHaveTextContent("Growth Desk");
		await expect(canvas.getByRole("link", { name: "Approvals, 1 waiting on you" })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** A request opened in full: every field in a table, Allow and Deny, and its chat. */
export const Opened = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/approvals/0199a3a0-0000-7000-8000-000000000701`} />
	),
	play: async ({ canvas }) => {
		const page = await canvas.findByRole(
			"article",
			{ name: "Approval request: Send quote in Stripe" },
			{ timeout: 10_000 },
		);
		await expect(page).toHaveTextContent("Acme Retail");
		await expect(canvas.getByRole("link", { name: "Open in Growth Desk" })).toBeInTheDocument();
	},
});

/** One already answered, opened from the Answered tab, which says who answered it and when. */
export const Answered = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/approvals/0199a3a0-0000-7000-8000-000000000702`} />
	),
});

/** Nothing waiting: it says you're clear, and still lists what was answered. */
export const Clear = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({ ...inbox, waiting: [] }),
			),
		);
	},
});
