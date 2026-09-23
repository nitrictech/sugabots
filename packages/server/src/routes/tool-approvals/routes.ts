import { toolApprovalDecisionSchema } from "@sugabots/contracts";
import type {
	ToolApprovalConflict,
	ToolApprovalForbidden,
	ToolApprovalNotFound,
	ToolApprovalStore,
} from "@sugabots/core/conversations/tools/approvals/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requirePod } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface ToolApprovalRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	approvals: ToolApprovalStore;
}

export function createToolApprovalRoutes({
	resolveSession,
	authorization,
	run,
	approvals,
}: ToolApprovalRoutesOptions) {
	const session = requireSession(resolveSession);
	const readsPod = requirePod(authorization, run, "pod.read");
	// The decision a caller may make depends on the tool call — a Routine's
	// action and an "always allow" ask more than an ordinary approval — so the
	// route admits anyone who may decide at all and the store, inside the same
	// transaction that settles the call, decides the rest.
	const decidesApprovals = requirePod(authorization, run, "approval.decide");
	const revokesRules = requirePod(authorization, run, "approval.revoke");

	return new Hono<AuthEnv>()
		.post(
			"/pods/:podId/tool-calls/:toolCallId/approval",
			session,
			decidesApprovals,
			body(toolApprovalDecisionSchema),
			async (c) => {
				const { pod } = c.get("pod");
				const userId = c.get("session").user.id;
				const toolCallId = c.req.param("toolCallId");
				if (!isUuid(toolCallId)) throw new HttpError("not_found", "No such pending tool approval");
				return c.json(
					await run(
						approvals
							.decide({
								workspaceId: pod.workspaceId,
								podId: pod.id,
								toolCallId,
								userId,
								decision: c.req.valid("json").decision,
							})
							.pipe(asHttpError(approvalErrors)),
					),
				);
			},
		)
		.get("/pods/:podId/tool-approval-rules", session, readsPod, async (c) => {
			const { pod } = c.get("pod");
			return c.json(await run(approvals.listRules(pod.workspaceId, pod.id)));
		})
		.delete("/pods/:podId/tool-approval-rules/:ruleId", session, revokesRules, async (c) => {
			const { pod } = c.get("pod");
			const ruleId = c.req.param("ruleId");
			if (!isUuid(ruleId)) throw new HttpError("not_found", "No such tool approval rule");
			const removed = await run(approvals.revokeRule(pod.workspaceId, pod.id, ruleId));
			if (!removed) throw new HttpError("not_found", "No such tool approval rule");
			return c.body(null, 204);
		});
}

const approvalErrors = {
	ToolApprovalNotFound: (_failure: ToolApprovalNotFound) =>
		new HttpError("not_found", "No such pending tool approval"),
	ToolApprovalConflict: (_failure: ToolApprovalConflict) =>
		new HttpError("conflict", "That tool approval has already been decided"),
	ToolApprovalForbidden: (_failure: ToolApprovalForbidden) =>
		new HttpError("forbidden", "You are not allowed to make that decision"),
};

const isUuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
