import type { AnsweredApproval, ApprovalRequest, ToolCallPart } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, projects } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const project = projects[0] as (typeof projects)[number];
const host = {
	kind: "bot" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	eyes: linear.eyes,
	shape: linear.shape,
};

function call(id: string, approval: ToolCallPart["approval"]): ToolCallPart {
	return {
		type: "tool_call",
		id,
		tool: "linear__update_issue",
		input: { team: "Platform" },
		output: null,
		status: approval?.status === "pending" ? "awaiting_approval" : "completed",
		error: null,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: null,
		approval,
	};
}

function request(id: string, approval: ToolCallPart["approval"]): ApprovalRequest {
	return {
		call: call(id, approval),
		bot: host,
		projectId: project.id,
		chatId: "0199a3a0-0000-7000-8000-0000000003b1",
		rootChatId: "0199a3a0-0000-7000-8000-0000000003b1",
	};
}

const waiting = request("0199a3a0-0000-7000-8000-0000000003c1", {
	status: "pending",
	approvers: "chat",
	decidedByName: null,
	decidedAt: null,
});
const decided = {
	status: "allowed",
	approvers: "chat",
	decidedByName: "Mia Chen",
	decidedAt: "2026-09-18T09:05:00.000Z",
} as const;
const answered: AnsweredApproval = {
	...request("0199a3a0-0000-7000-8000-0000000003c2", decided),
	answer: decided,
};

function serveApprovals(contents: { waiting: ApprovalRequest[]; answered: AnsweredApproval[] }) {
	client.api.chats.approvals.mockReturnValue(Effect.succeed(contents));
}

beforeEach(() => {
	apiAnswers();
	serveApprovals({ waiting: [waiting], answered: [answered] });
	client.api.approvals.decide.mockReturnValue(Effect.undefined);
});

describe("Approvals", () => {
	it("says how a request in the address was answered, with the way back to Approvals", async () => {
		mount(`/suga/approvals/${answered.call.id}`);

		const article = await screen.findByRole("article", {
			name: /^Approval request/,
		});
		within(article).getByText(/Allowed by Mia Chen/);
		expect(within(article).queryByRole("button", { name: /^Allow/ })).toBeNull();
		expect(
			within(article).getByRole("link", { name: "Back to Approvals" }).getAttribute("href"),
		).toBe("/suga/approvals");
	});

	it("answers a request where it waits, and lists it under Resolved", async () => {
		mount("/suga/approvals");

		const card = await screen.findByRole("article", { name: /Update issue/ });
		serveApprovals({
			waiting: [],
			answered: [{ ...waiting, answer: { ...decided, decidedByName: "Sam" } }, answered],
		});
		fireEvent.click(within(card).getByRole("button", { name: /^Allow/ }));

		await waitFor(() => expect(client.api.approvals.decide).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByRole("article", { name: /Update issue/ })).toBeNull());
		expect(screen.getAllByRole("link", { name: /Update issue/ })).toHaveLength(2);
		screen.getByText(/^Nothing waiting/);
	});

	it("opens a request raised in an automation's run at the automation's feed, naming the run", async () => {
		const run = "0199a3a0-0000-7000-8000-0000000003d1";
		const feed = "0199a3a0-0000-7000-8000-0000000003d2";
		const inChat = {
			...waiting,
			projectId: null,
			chatId: run,
			rootChatId: feed,
		};
		const inProject = {
			...request("0199a3a0-0000-7000-8000-0000000003c3", waiting.call.approval),
			chatId: run,
			rootChatId: feed,
		};

		serveApprovals({ waiting: [inChat], answered: [] });
		mount(`/suga/approvals/${inChat.call.id}`);
		expect((await screen.findByRole("link", { name: "Open chat" })).getAttribute("href")).toBe(
			`/suga/chats/${feed}?nestedChatPage=${run}`,
		);
		cleanup();

		serveApprovals({ waiting: [inProject], answered: [] });
		mount(`/suga/approvals/${inProject.call.id}`);
		expect((await screen.findByRole("link", { name: "Open chat" })).getAttribute("href")).toBe(
			`/suga/projects/${project.slug}/${feed}?nestedChatPage=${run}`,
		);
	});
});
