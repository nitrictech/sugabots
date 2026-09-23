import type { ToolCallPart } from "@sugabots/contracts";
import {
	noToolApprovalStore,
	ToolApprovalForbidden,
	type ToolApprovalStore,
} from "@sugabots/core/conversations/tools/approvals/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const ADMIN_ID = "0199a3a0-0000-7000-8000-000000000002";
const MEMBER_ID = "0199a3a0-0000-7000-8000-000000000003";
const POD_ID = "0199a3a0-0000-7000-8000-000000000004";
const CALL_ID = "0199a3a0-0000-7000-8000-000000000005";

const resolveSession: SessionResolver = async (headers) => {
	const admin = headers.get("authorization") === "Bearer admin";
	return {
		user: {
			id: admin ? ADMIN_ID : MEMBER_ID,
			name: admin ? "Ada" : "Sam",
			email: admin ? "ada@example.com" : "sam@example.com",
			image: null,
		},
	};
};

/** Ada administers the workspace; Sam is an ordinary member of the pod. */
const authorization = testAuthorization({
	id: WORKSPACE_ID,
	roles: { [ADMIN_ID]: "admin", [MEMBER_ID]: "member" },
	pods: [{ id: POD_ID, kind: "shared", members: [MEMBER_ID], name: "Support", slug: "support" }],
});

const pending: ToolCallPart = {
	type: "tool_call",
	id: CALL_ID,
	tool: "linear__create_issue",
	input: { title: "Broken nav" },
	output: null,
	status: "awaiting_approval",
	approval: { status: "pending", decidedByName: null, decidedAt: null },
	error: null,
	mutating: true,
	atOffset: 0,
	startedAt: "2026-09-14T00:00:00.000Z",
	finishedAt: null,
};

function app() {
	const decide = vi.fn<ToolApprovalStore["decide"]>((input) =>
		input.decision === "always_allow" && input.userId !== ADMIN_ID
			? Effect.fail(new ToolApprovalForbidden())
			: Effect.succeed(pending),
	);
	return {
		decide,
		app: createTestApp({
			resolveSession,
			authorization,
			stores: { approvals: { ...noToolApprovalStore, decide } },
		}),
	};
}

describe("tool approval routes", () => {
	it("lets a pod member allow one exact call", async () => {
		const built = app();
		const response = await built.app.request(`/pods/${POD_ID}/tool-calls/${CALL_ID}/approval`, {
			method: "POST",
			headers: { authorization: "Bearer member", "content-type": "application/json" },
			body: JSON.stringify({ decision: "allow_once" }),
		});

		expect(response.status).toBe(200);
		expect(built.decide).toHaveBeenCalledWith(
			expect.objectContaining({ userId: MEMBER_ID, decision: "allow_once" }),
		);
	});

	it("leaves Always allow to the store, which refuses a member", async () => {
		const built = app();
		const response = await built.app.request(`/pods/${POD_ID}/tool-calls/${CALL_ID}/approval`, {
			method: "POST",
			headers: { authorization: "Bearer member", "content-type": "application/json" },
			body: JSON.stringify({ decision: "always_allow" }),
		});

		expect(response.status).toBe(403);
	});

	it("lets an admin who is not in the pod decide", async () => {
		const built = app();
		const response = await built.app.request(`/pods/${POD_ID}/tool-calls/${CALL_ID}/approval`, {
			method: "POST",
			headers: { authorization: "Bearer admin", "content-type": "application/json" },
			body: JSON.stringify({ decision: "always_allow" }),
		});

		expect(response.status).toBe(200);
	});

	it("refuses a member revoking a standing approval", async () => {
		const response = await app().app.request(`/pods/${POD_ID}/tool-approval-rules/${CALL_ID}`, {
			method: "DELETE",
			headers: { authorization: "Bearer member" },
		});

		expect(response.status).toBe(403);
	});
});
