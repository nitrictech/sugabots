import type { AnsweredApproval, ApprovalRequest, ToolCallPart } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, channels, linear, mount } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const channel = channels[0] as (typeof channels)[number];
const host = {
	kind: "bot" as const,
	id: linear.id,
	name: linear.name,
	handle: linear.handle,
	color: linear.color,
	face: linear.face,
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
		bot: host,
		channelId: channel.id,
		conversationId: "0199a3a0-0000-7000-8000-0000000003b1",
		rootConversationId: "0199a3a0-0000-7000-8000-0000000003b1",
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
	client.api.approvals.decide.mockReturnValue(Effect.undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Approvals", () => {
	it("says how a request in the address was answered, with the way back to Approvals", async () => {
		mount(`/suga/approvals/${answered.call.id}`);

		const article = await screen.findByRole("article", {
			name: /^Approval request/,
		});
		expect(within(article).getByText(/Allowed by Mia Chen/)).toBeDefined();
		expect(within(article).queryByRole("button", { name: /^Allow/ })).toBeNull();
		expect(
			within(article).getByRole("link", { name: "Back to Approvals" }).getAttribute("href"),
		).toBe("/suga/approvals");
	});

	it("answers a request where it waits, and lists it under Resolved", async () => {
		mount("/suga/approvals");

		const card = await screen.findByRole("article", { name: /Update issue/ });
		inbox({
			waiting: [],
			answered: [{ ...waiting, answer: { ...decided, decidedByName: "Sam" } }, answered],
		});
		fireEvent.click(within(card).getByRole("button", { name: /^Allow/ }));

		await waitFor(() => expect(client.api.approvals.decide).toHaveBeenCalled());
		await waitFor(() => expect(screen.queryByRole("article", { name: /Update issue/ })).toBeNull());
		expect(screen.getAllByRole("link", { name: /Update issue/ })).toHaveLength(2);
		expect(screen.getByText(/^Nothing waiting/)).toBeDefined();
	});

	it("opens a request raised in a collaboration at the asker's conversation, not the collaborator's", async () => {
		const collaboration = "0199a3a0-0000-7000-8000-0000000003d1";
		const root = "0199a3a0-0000-7000-8000-0000000003d2";
		const inTask = {
			...waiting,
			channelId: null,
			conversationId: collaboration,
			rootConversationId: root,
		};
		const inChannel = {
			...request("0199a3a0-0000-7000-8000-0000000003c3", waiting.call.approval),
			conversationId: collaboration,
			rootConversationId: root,
		};

		inbox({ waiting: [inTask], answered: [] });
		mount(`/suga/approvals/${inTask.call.id}`);
		expect(
			(await screen.findByRole("link", { name: "Open conversation" })).getAttribute("href"),
		).toBe(`/suga/tasks/${root}?item=${collaboration}`);
		cleanup();

		inbox({ waiting: [inChannel], answered: [] });
		mount(`/suga/approvals/${inChannel.call.id}`);
		expect(
			(await screen.findByRole("link", { name: "Open conversation" })).getAttribute("href"),
		).toBe(`/suga/channels/${channel.slug}/${root}?item=${collaboration}`);
	});

	it("says a request is gone when the inbox no longer holds it", async () => {
		mount("/suga/approvals/0199a3a0-0000-7000-8000-0000000003c9");

		expect(await screen.findByText("This request is no longer here")).toBeDefined();
	});
});
