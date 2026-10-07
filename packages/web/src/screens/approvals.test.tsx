import type { AnsweredApproval, ApprovalRequest, ToolCallPart } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, pods } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const pod = pods[0] as (typeof pods)[number];
const host = {
	kind: "agent" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	face: linear.face,
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
		mutating: true,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: null,
		approval,
	};
}

function request(id: string, approval: ToolCallPart["approval"]): ApprovalRequest {
	return {
		call: call(id, approval),
		agent: host,
		podId: pod.id,
		threadId: "0199a3a0-0000-7000-8000-0000000003b1",
		chatAgentId: linear.id,
		inMainThread: true,
	};
}

const waiting = request("0199a3a0-0000-7000-8000-0000000003c1", {
	status: "pending",
	decidedByName: null,
	decidedAt: null,
});
const decided = {
	status: "allowed",
	decidedByName: "Mia Chen",
	decidedAt: "2026-09-18T09:05:00.000Z",
} as const;
const answered: AnsweredApproval = {
	...request("0199a3a0-0000-7000-8000-0000000003c2", decided),
	answer: decided,
};

function inbox(contents: { waiting: ApprovalRequest[]; answered: AnsweredApproval[] }) {
	client.api.chats.approvals.mockReturnValue(Effect.succeed(contents));
}

beforeEach(() => {
	apiAnswers();
	inbox({ waiting: [waiting], answered: [answered] });
	client.api.toolApprovals.decide.mockReturnValue(Effect.undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Approvals", () => {
	it("opens on Answered when the request in the address was answered, and says how", async () => {
		mount(`/suga/approvals/${answered.call.id}`);

		const article = await screen.findByRole("article", {
			name: /^Approval request/,
		});
		expect(within(article).getByText(/Allowed by Mia Chen/)).toBeDefined();
		expect(within(article).queryByRole("button", { name: /^Allow/ })).toBeNull();
		expect(screen.getByRole("tab", { name: "Answered" }).getAttribute("aria-selected")).toBe(
			"true",
		);
	});

	it("keeps the list on Waiting on you while a request chosen there is answered", async () => {
		mount("/suga/approvals");

		const list = await screen.findByRole("region", { name: "Approvals" });
		fireEvent.click(await within(list).findByRole("link", { name: /Update issue/ }));
		const allow = await screen.findByRole("button", { name: /^Allow/ });
		inbox({
			waiting: [],
			answered: [{ ...waiting, answer: { ...decided, decidedByName: "Sam" } }, answered],
		});
		fireEvent.click(allow);

		await waitFor(() => expect(client.api.toolApprovals.decide).toHaveBeenCalled());
		expect(await screen.findByText(/Allowed by Sam/)).toBeDefined();
		expect(screen.getByRole("tab", { name: /Waiting on you/ }).getAttribute("aria-selected")).toBe(
			"true",
		);
	});

	it("says a request is gone when the inbox no longer holds it", async () => {
		mount("/suga/approvals/0199a3a0-0000-7000-8000-0000000003c9");

		expect(await screen.findByText("This request is no longer here")).toBeDefined();
	});
});
