import { connectorToolWritesOrDeletes } from "@sugabots/contracts";
import { ApprovalNeeded, ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { Approval } from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type TurnFacts, turnFacts } from "../authentication/turn-facts.ts";
import { type Database, query } from "../database/database.ts";
import { connector, toolCall } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { toolAccessOf } from "../providers/connectors/tool-access.ts";
import { approverFacts, approverRuleOf } from "./approvers.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * When an operation's call waits for approval: its bot-loop approval in the
 * exposure manifest, whether its contract says it changes anything, and for a
 * connector's tool, which tool of which connector, whose tool access decides.
 */
export interface ApprovalRule {
	readonly approval: Approval;
	readonly changes: boolean;
	readonly connectorTool?: { readonly connector: string; readonly tool: string };
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
}

const ApprovedProof = defineProof("Approved");

/** What the call needs before it runs, once the turn's own rules are applied. */
type Need = "nothing" | "approver" | "refused";

export const proveApproved = <P, X>(
	principal: Named<P, Principal>,
	callNamed: Named<X, Call>,
	rule: ApprovalRule,
	input: unknown,
) =>
	Effect.gen(function* () {
		const approved = (decidedBy: string | null) => {
			const proof: Approved<P, X> = ApprovedProof.prove([principal, callNamed], {
				principal,
				call: callNamed,
				decidedBy,
			});
			return proof;
		};
		const acting = principal.value;
		if (acting._tag !== "BotForAsker" && acting._tag !== "AutomationRun") return approved(null);
		const facts = yield* query((db) => turnFacts(db, acting.turn));
		if (!facts) return yield* Effect.fail(new ApprovalRefused());
		const need = yield* needOf(facts, rule);
		if (need === "refused") return yield* Effect.fail(new ApprovalRefused());
		if (need === "nothing") return approved(null);

		const call = callNamed.value;
		if (call.kind !== "toolCall" || !isUuid(call.toolCall))
			return yield* Effect.fail(new ApprovalNeeded());
		const [decision] = yield* query((db) =>
			db
				.select({
					tool: toolCall.tool,
					status: toolCall.approvalStatus,
					decidedBy: toolCall.decidedById,
					executionInput: toolCall.executionInput,
					input: toolCall.input,
				})
				.from(toolCall)
				.where(and(eq(toolCall.id, call.toolCall), eq(toolCall.turnId, acting.turn)))
				.limit(1),
		);
		if (decision?.status === "denied") return yield* Effect.fail(new ApprovalRefused());
		if (decision?.status !== "allowed" || !decision.decidedBy) {
			return yield* Effect.fail(new ApprovalNeeded());
		}
		const decidedBy = decision.decidedBy;
		const { approver } = yield* approverFacts(
			decidedBy,
			facts,
			approverRuleOf(facts, decision.tool),
		);
		if (!approver) return yield* Effect.fail(new ApprovalNeeded());
		if (canonicalJson(decision.executionInput ?? decision.input) !== canonicalJson(input)) {
			return yield* Effect.fail(new ApprovalRefused());
		}
		return approved(decidedBy);
	});

/**
 * What a call needs, by its rule and the turn's: a Personal Assistant's calls
 * that change anything, and every call in its runs that came from outside,
 * wait for its member; a connector's tool switched off is refused, one set to
 * Allow runs, and one set to Ask waits.
 */
const needOf = (facts: TurnFacts, rule: ApprovalRule) =>
	Effect.gen(function* (): Effect.fn.Return<Need, never, Database> {
		const tool = rule.approval.kind === "byToolAccess" ? yield* connectorToolOf(rule) : undefined;
		if (rule.approval.kind === "byToolAccess" && tool?.access === "off") return "refused";
		const assistants = facts.assistantOf !== null || facts.briefedByAssistant;
		const fromOutside =
			facts.assistantOf !== null &&
			facts.inOwnChats &&
			(facts.run?.startedBy === "webhook" || facts.run?.startedBy === "github");
		const changes = tool ? tool.writeOrDelete : rule.changes;
		if (fromOutside || (assistants && changes)) return "approver";
		switch (rule.approval.kind) {
			case "never":
				return "nothing";
			case "always":
				return "approver";
			case "byToolAccess":
				return tool?.access === "allow" ? "nothing" : "approver";
		}
	});

/** The access and write/delete flag of the connector tool `rule` names, as they stand now. */
const connectorToolOf = (rule: ApprovalRule) =>
	Effect.gen(function* () {
		const named = rule.connectorTool;
		if (!named || !isUuid(named.connector)) return undefined;
		const [row] = yield* query((db) =>
			db
				.select({ tools: connector.tools, toolAccess: connector.toolAccess })
				.from(connector)
				.where(eq(connector.id, named.connector))
				.limit(1),
		);
		if (!row) return undefined;
		const described = row.tools.find((listed) => listed.name === named.tool) ?? {
			name: named.tool,
			description: null,
			readOnly: null,
			destructive: null,
		};
		return {
			access: toolAccessOf(row.toolAccess, described),
			writeOrDelete: connectorToolWritesOrDeletes(described),
		};
	});

/** JSON with every object's keys in order, so equal values compare equal however they were written. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested: unknown) =>
		nested !== null && typeof nested === "object" && !Array.isArray(nested)
			? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
			: nested,
	);
}
