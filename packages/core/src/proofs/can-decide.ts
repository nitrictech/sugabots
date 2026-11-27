import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { turnFacts } from "../authentication/turn-facts.ts";
import { approversOf } from "../chats/tools/approvers.ts";
import { query } from "../database/database.ts";
import { chat, membership, toolCall, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { type ApproverRule, approverFacts } from "./approvers.ts";
import type { IsMember } from "./is-member.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a member and an approver for the tool call X, by the first approver
 * rule that fits. Someone who neither is an approver nor reaches X's chat gets
 * `ResourceHidden`; one who reaches it without being an approver,
 * `ActionForbidden`. An approver who doesn't reach the chat, such as a
 * project's manager deciding a host request, sees only the call's fixed fields.
 */
export interface CanDecide<P, X> extends Proof<"CanDecide", [P, X]> {
	readonly principal: Named<P, Principal>;
	readonly call: Named<X, string>;
	readonly rule: ApproverRule;
	readonly computerProjectId: string | undefined;
	/** Whether P reaches X's chat, and so may read what the model wrote there. */
	readonly reachesChat: boolean;
}

const CanDecideProof = defineProof("CanDecide");

export const proveCanDecide = <P, X>(isMember: IsMember<P>, callId: Named<X, string>) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "approval" });
		const id = callId.value;
		const [call] = isUuid(id)
			? yield* query((db) =>
					db
						.select({
							turn: toolCall.turnId,
							tool: toolCall.tool,
							computerProjectId: toolCall.approvalComputerProjectId,
						})
						.from(toolCall)
						.innerJoin(chat, eq(chat.id, toolCall.chatId))
						.innerJoin(
							workspace,
							and(eq(workspace.id, chat.workspaceId), eq(workspace.deleting, false)),
						)
						.innerJoin(
							membership,
							and(
								eq(membership.workspaceId, chat.workspaceId),
								eq(membership.memberId, isMember.member),
								eq(membership.leaving, false),
							),
						)
						.where(eq(toolCall.id, id))
						.limit(1),
				)
			: [];
		const facts = call && (yield* query((db) => turnFacts(db, call.turn)));
		if (!call || !facts) return yield* Effect.fail(hidden);
		const computerRequest = approversOf(call.tool) === "computer-managers";
		const computerProjectId = computerRequest ? (call.computerProjectId ?? undefined) : undefined;
		if (computerRequest && !computerProjectId) return yield* hidden;
		const { rule, approver, reachesChat } = yield* approverFacts(
			isMember.member,
			facts,
			computerProjectId,
		);
		if (!approver) {
			return yield* Effect.fail(reachesChat ? new ActionForbidden({ proof: "CanDecide" }) : hidden);
		}
		const proof: CanDecide<P, X> = CanDecideProof.prove([isMember.principal, callId], {
			principal: isMember.principal,
			call: callId,
			rule,
			computerProjectId,
			reachesChat,
		});
		return proof;
	});
