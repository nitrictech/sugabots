import { Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import type { ToolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface ToolApprovalRoutesOptions {
	approvals: ToolApprovalStore;
}

export function toolApprovalRoutes({ approvals }: ToolApprovalRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "toolApprovals", (handlers) =>
		handlers
			.handle("decide", ({ params, payload }) =>
				Effect.gen(function* () {
					const { pod, actor } = yield* grantedPod;
					if (!isUuid(params.toolCallId)) {
						return yield* new NotFound({ message: "No such pending tool approval" });
					}
					return yield* approvals
						.decide({
							workspaceId: pod.workspaceId,
							podId: pod.id,
							toolCallId: params.toolCallId,
							userId: actor.userId,
							decision: payload.decision,
						})
						.pipe(asHttpError(approvalErrors));
				}),
			)
			.handle("listRules", () =>
				Effect.flatMap(grantedPod, ({ pod }) => approvals.listRules(pod.workspaceId, pod.id)),
			)
			.handle("revokeRule", ({ params }) =>
				Effect.gen(function* () {
					const { pod } = yield* grantedPod;
					const removed =
						isUuid(params.ruleId) &&
						(yield* approvals.revokeRule(pod.workspaceId, pod.id, params.ruleId));
					if (!removed) {
						return yield* new NotFound({ message: "No such tool approval rule" });
					}
				}),
			),
	);
}

const approvalErrors = {
	ToolApprovalNotFound: () => new NotFound({ message: "No such pending tool approval" }),
	ToolApprovalConflict: () =>
		new Conflict({ message: "That tool approval has already been decided" }),
	ToolApprovalForbidden: () =>
		new Forbidden({ message: "You are not allowed to make that decision" }),
};

const isUuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
