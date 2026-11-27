import type {
	AnsweredApproval,
	ApprovalRequest,
	ToolCallPart,
	WorkspaceApprovals,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { storyApproval } from "@/shell/approval-story.test-support.ts";
import { revenue } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

/*
 * Every approval across the workspace, opened from the sidebar: what waits on
 * you, each answerable here, and the latest answered.
 */

const API = import.meta.env.VITE_API_URL as string;

function request(id: string, tool: string, approval: ToolCallPart["approval"]) {
	return storyApproval({
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
		atOffset: 0,
		startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
		finishedAt: null,
		approval,
	});
}

function answered(id: string, tool: string, answer: AnsweredApproval["answer"]): AnsweredApproval {
	return { ...request(id, tool, { ...answer, id: "approval-1", approvers: "chat" }), answer };
}

const approvals: WorkspaceApprovals = {
	waiting: [
		request("01", "stripe__send_quote", {
			id: "approval-1",
			status: "pending",
			approvers: "chat",
			decidedByName: null,
			decidedAt: null,
		}),
	],
	answered: [
		answered("02", "gmail__send_email", {
			status: "allowed",
			decidedByName: "Rowan Ellis",
			decidedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		}),
		answered("03", "hubspot__delete_deal", {
			status: "denied",
			decidedByName: "Rowan Ellis",
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
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () => HttpResponse.json(approvals)),
			...appHandlers(),
		);
	},
	render: () => <StoryApp path={`/${storyWorkspace.slug}/approvals`} />,
});

/**
 * A request waiting on you, as a card with the request and Allow and Deny;
 * under it, the ones resolved, each with which way it went.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		const card = await canvas.findByRole("article", { name: /Send quote/ });
		await expect(card).toHaveTextContent("Acme Retail");
		await expect(within(card).getByRole("button", { name: /^Allow/ })).toBeVisible();
		await expect(within(card).getByRole("button", { name: /^Deny/ })).toBeVisible();
		await expect(canvas.getByRole("link", { name: /Delete deal/ })).toHaveTextContent("Denied");
	},
});

/** A new approval for the same tool call can be answered as soon as it arrives. */
export const ReplacementRequest = meta.story({
	beforeEach({ msw }) {
		let waiting = approvals.waiting;
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({ ...approvals, waiting }),
			),
			http.post(`${API}/tool-calls/:toolCallId/approval`, async ({ request: decision }) => {
				await expect(decision.json()).resolves.toEqual({
					approvalId: "approval-1",
					decision: "allow_once",
				});
				const replacement = request("01", "stripe__send_quote", {
					id: "approval-2",
					status: "pending",
					approvers: "chat",
					decidedByName: null,
					decidedAt: null,
				});
				waiting = [
					{ ...replacement, call: { ...replacement.call, input: { customer: "Northwind" } } },
				];
				return new HttpResponse(null, { status: 202 });
			}),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const card = within(await canvas.findByRole("article", { name: /Send quote/ }));
		await userEvent.click(card.getByRole("button", { name: /^Allow/ }));
		await expect(await card.findByText("Northwind")).toBeVisible();
		await expect(card.getByRole("button", { name: /^Allow/ })).toBeEnabled();
		await expect(card.getByRole("button", { name: /^Deny/ })).toBeEnabled();
	},
});

/** A request opened in full: every field in a table, Allow and Deny, and its chat. */
export const Opened = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/approvals/0199a3a0-0000-7000-8000-000000000701`} />
	),
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("article", {
			name: "Approval request: Send quote in Stripe",
		});
		await expect(page).toHaveTextContent("Acme Retail");
		// The link waits for the projects and bots too, which can answer after the request.
		await expect(await canvas.findByRole("link", { name: "Open chat" })).toBeInTheDocument();
	},
});

/** One already answered, opened from Resolved, which says who answered it and when. */
export const Answered = meta.story({
	render: () => (
		<StoryApp path={`/${storyWorkspace.slug}/approvals/0199a3a0-0000-7000-8000-000000000702`} />
	),
});

/** Nothing waiting: it says so, and still lists what was resolved. */
export const Clear = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({ ...approvals, waiting: [] }),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/^Nothing waiting/)).toBeVisible();
		await expect(canvas.getByRole("link", { name: /Send email/ })).toHaveTextContent("Allowed");
	},
});

/** HostRequestOutsideTheChat shows what the computer needs to reach and where it was requested. */
export const HostRequestOutsideTheChat = meta.story({
	beforeEach({ msw }) {
		const pending = request("04", "request_host", {
			id: "approval-1",
			status: "pending",
			approvers: "computer-managers",
			decidedByName: null,
			decidedAt: null,
		});
		const outside: ApprovalRequest = {
			...pending,
			chatId: null,
			rootChatId: null,
			projectName: revenue.name,
			call: { ...pending.call, input: { host: "api.acme.example" } },
		};
		msw.use(
			http.get(`${API}/workspaces/:workspace/chats/approvals`, () =>
				HttpResponse.json({ waiting: [outside], answered: [] } satisfies WorkspaceApprovals),
			),
		);
	},
	play: async ({ canvas }) => {
		const card = within(await canvas.findByRole("article", { name: "Growth Desk: Request host" }));
		await expect(
			card.getByText(/Growth Desk wants the project's computer to reach a new host/),
		).toBeVisible();
		await expect(card.getByText("api.acme.example")).toBeVisible();
	},
});
