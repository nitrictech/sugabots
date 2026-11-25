import { connectorToolKey } from "@sugabots/contracts";
import { ApprovalNeeded, ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import {
	type Approval,
	type BotLoopOperationName,
	manifest,
	operationContracts,
} from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { asksBeforeAllTools, type TurnFacts, turnFacts } from "../authentication/turn-facts.ts";
import { decodeRecordedBuiltInInput } from "../chats/tools/recorded-input.ts";
import { query } from "../database/database.ts";
import { toolCall } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { ApprovalCheckReached, type Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { approverFacts } from "./approvers.ts";
import type { CanUseChatComputer } from "./can-use-computer.ts";
import type { CanUseConnector } from "./can-use-connector.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

export interface ApprovalRule<A extends Approval = Approval> {
	readonly tool: string;
	readonly approval: A;
	readonly changes: boolean;
}

export function approvalRule<N extends BotLoopOperationName<typeof manifest>>(
	name: N,
): ApprovalRule<(typeof manifest)[N]["botLoop"]["approval"]>;
export function approvalRule(name: BotLoopOperationName<typeof manifest>): ApprovalRule {
	const { tool, approval } = manifest[name].botLoop;
	return { tool, approval, changes: operationContracts[name].changes };
}

/**
 * The call X may run for P: P isn't a bot in a turn, so no approval applies;
 * X needs none; or someone still an approver for it allowed it, its tool's
 * access still lets it, and the arguments they allowed equal X's input. The
 * decision is stored, not a proof, and this proves it again each time.
 *
 * A Personal Assistant's call that changes anything always waits, and so does
 * every call in its runs a webhook or GitHub event started, and a brief's
 * first turn follows a Personal Assistant's rule when one wrote the brief.
 */
export interface Approved<P, X> extends Proof<"Approved", [P, X]> {
	readonly principal: Named<P, Principal>;
	readonly call: Named<X, Call>;
	/** The member who allowed it; none when it needed no one. */
	readonly decidedBy: string | null;
	readonly sdkToolCallId: string | null;
	readonly connectorCall:
		| {
				readonly connectorId: string;
				readonly revision: number;
				readonly tool: string;
				readonly arguments: unknown;
		  }
		| undefined;
}

const ApprovedProof = defineProof("Approved");

/** What the call needs before it runs, once the turn's own rules are applied. */
type Need = "nothing" | "approver" | "refused";

export type OrdinaryApproval =
	| Exclude<Approval, { kind: "always" }>
	| {
			readonly kind: "always";
			readonly approvers: Exclude<
				Extract<Approval, { kind: "always" }>["approvers"],
				"computerManagers"
			>;
	  };

export const proveApproved = <P, X, K>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval>,
	input: unknown,
	connectorUse?: CanUseConnector<NoInfer<P>, K>,
) => proveApproval(principal, call, rule, input, connectorUse, undefined);

export const proveComputerRequestApproved = <P, X, C>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	input: unknown,
	computerUse: CanUseChatComputer<NoInfer<P>, C>,
) =>
	proveApproval(
		principal,
		call,
		approvalRule("computers.requestHost"),
		input,
		undefined,
		computerUse.project,
	);

const proveApproval = <P, X, K>(
	principal: Named<P, Principal>,
	callNamed: Named<X, Call>,
	rule: ApprovalRule,
	input: unknown,
	connectorUse: CanUseConnector<P, K> | undefined,
	computerProjectId: string | undefined,
) =>
	Effect.gen(function* () {
		const approved = (decidedBy: string | null, sdkToolCallId: string | null = null) => {
			const proof: Approved<P, X> = ApprovedProof.prove([principal, callNamed], {
				principal,
				call: callNamed,
				decidedBy,
				sdkToolCallId,
				connectorCall: connectorUse && {
					connectorId: connectorUse.reach.connector.value,
					revision: connectorUse.reach.revision,
					tool: connectorUse.tool,
					arguments: input,
				},
			});
			return proof;
		};
		const call = callNamed.value;
		if (call.kind === "approvalCheck") {
			if (connectorUse?.access === "off") return yield* new ApprovalRefused();
			return yield* ApprovalCheckReached.for({
				...(computerProjectId && { computerProjectId }),
				...(connectorUse && { connectorAccess: connectorUse.access }),
				writeOrDelete: connectorUse?.writeOrDelete ?? rule.changes,
			});
		}
		const acting = principal.value;
		if (acting._tag !== "BotForAsker" && acting._tag !== "AutomationRun") return approved(null);
		const facts = yield* query((db) => turnFacts(db, acting.turn));
		if (!facts) return yield* Effect.fail(new ApprovalRefused());
		const need = approvalNeed(facts, rule, connectorUse);
		if (need === "refused") return yield* Effect.fail(new ApprovalRefused());
		if (call.kind !== "toolCall" || !isUuid(call.toolCall))
			return need === "nothing" && !connectorUse ? approved(null) : yield* new ApprovalNeeded();
		const [decision] = yield* query((db) =>
			db
				.select({
					tool: toolCall.tool,
					computerProjectId: toolCall.approvalComputerProjectId,
					accessAtApproval: toolCall.approvalConnectorAccess,
					connectorId: toolCall.connectorId,
					connectorRevision: toolCall.connectorRevision,
					remoteToolName: toolCall.remoteToolName,
					callStatus: toolCall.status,
					sentInExecution: toolCall.sentInExecution,
					writeOrDelete: toolCall.writeOrDelete,
					sdkToolCallId: toolCall.sdkToolCallId,
					status: toolCall.approvalStatus,
					decidedBy: toolCall.decidedById,
					executionInput: toolCall.executionInput,
					input: toolCall.input,
				})
				.from(toolCall)
				.where(and(eq(toolCall.id, call.toolCall), eq(toolCall.turnId, acting.turn)))
				.limit(1),
		);
		const name = connectorUse
			? connectorToolKey(connectorUse.reach.handle, connectorUse.tool)
			: rule.tool;
		if (
			connectorUse &&
			(decision?.callStatus !== "running" ||
				decision.sentInExecution !== acting.executionNumber ||
				decision.connectorId !== connectorUse.reach.connector.value ||
				decision.connectorRevision !== connectorUse.reach.revision ||
				decision.remoteToolName !== connectorUse.tool ||
				(connectorUse.writeOrDelete && !decision.writeOrDelete) ||
				canonicalJson(decision.executionInput ?? decision.input) !== canonicalJson(input))
		)
			return yield* new ApprovalRefused();
		if (
			decision &&
			(decision.tool !== name ||
				decision.status === "denied" ||
				(decision.status === "allowed" &&
					computerProjectId !== undefined &&
					computerProjectId !== decision.computerProjectId))
		)
			return yield* Effect.fail(new ApprovalRefused());
		if (need === "nothing" && !decision?.status) return approved(null, decision?.sdkToolCallId);
		if (
			decision?.status === "allowed" &&
			!sameInputAsRecorded(name, decision.executionInput ?? decision.input, input)
		) {
			return yield* new ApprovalRefused();
		}
		if (
			decision?.status !== "allowed" ||
			!decision.decidedBy ||
			(connectorUse?.access === "ask" && decision.accessAtApproval !== "ask")
		) {
			return yield* Effect.fail(new ApprovalNeeded());
		}
		const decidedBy = decision.decidedBy;
		const { approver } = yield* approverFacts(decidedBy, facts, computerProjectId);
		if (!approver) return yield* Effect.fail(new ApprovalNeeded());
		return approved(decidedBy, decision.sdkToolCallId);
	});

/**
 * Whether a built-in tool's call `input` is the one recorded: as stored, or as
 * the tool's contract decodes the stored arguments now.
 */
function sameInputAsRecorded(tool: string, recorded: unknown, input: unknown): boolean {
	const asked = canonicalJson(input);
	return (
		canonicalJson(recorded) === asked ||
		canonicalJson(decodeRecordedBuiltInInput(tool, recorded)) === asked
	);
}

/**
 * What a call needs, by its rule and the turn's: a Personal Assistant's calls
 * that change anything, and every call in its runs that came from outside,
 * wait for its member; a connector's tool switched off is refused, one set to
 * Allow runs, and one set to Ask waits.
 */
export function approvalNeed(
	facts: TurnFacts,
	rule: ApprovalRule,
	connectorUse?: Pick<CanUseConnector<unknown, unknown>, "access" | "writeOrDelete">,
): Need {
	if (rule.approval.kind === "byToolAccess" && (!connectorUse || connectorUse.access === "off"))
		return "refused";
	const changes = connectorUse?.writeOrDelete ?? rule.changes;
	if (
		asksBeforeAllTools(facts) ||
		((facts.assistantOf !== null || facts.briefedByAssistant) && changes)
	)
		return "approver";
	return rule.approval.kind === "always" || connectorUse?.access === "ask" ? "approver" : "nothing";
}

/** JSON with every object's keys in order, so equal values compare equal however they were written. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested: unknown) =>
		nested !== null && typeof nested === "object" && !Array.isArray(nested)
			? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
			: nested,
	);
}
