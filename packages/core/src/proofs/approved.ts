import { connectorToolKey } from "@sugabots/contracts";
import { ApprovalNeeded, ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import {
	type Approval,
	type BotLoopOperationName,
	type InputOf,
	operationContracts,
} from "@sugabots/contracts/operations";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
	asksBeforeAllTools,
	hasMemberBounds,
	startedFromOutside,
	type TurnFacts,
	turnFacts,
} from "../authentication/turn-facts.ts";
import { sameRecordedInput } from "../chats/tools/recorded-input.ts";
import { query } from "../database/database.ts";
import { toolCall } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { ApprovalCheckReached, type Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { approverFacts } from "./approvers.ts";
import type { CanUseChatComputer } from "./can-use-computer.ts";
import type { CanUseConnector } from "./can-use-connector.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

export type ApprovedOperation =
	| BotLoopOperationName<typeof operationContracts>
	| "automations.list";

export interface ApprovalRule<
	A extends Approval = Approval,
	N extends ApprovedOperation = ApprovedOperation,
> {
	readonly operation: N;
	readonly tool: string;
	readonly approval: A;
	/** Whether the operation writes something, which a call records. */
	readonly changes: boolean;
	/** Whether a personal bot's call waits for its creator (see the contract's `personalBotAsks`). */
	readonly personalBotAsks: boolean;
}

export function approvalRule<N extends BotLoopOperationName<typeof operationContracts>>(
	name: N,
): ApprovalRule<(typeof operationContracts)[N]["botLoop"]["approval"], N>;
export function approvalRule(
	name: "automations.list",
): ApprovalRule<
	(typeof operationContracts)["automations.listInChat"]["botLoop"]["approval"],
	"automations.list"
>;
export function approvalRule(name: ApprovedOperation): ApprovalRule {
	const policy = name === "automations.list" ? "automations.listInChat" : name;
	const { tool, approval, personalBotAsks } = operationContracts[policy].botLoop;
	return {
		operation: name,
		tool,
		approval,
		changes: operationContracts[name].changes,
		personalBotAsks,
	};
}

/**
 * The operation may run on Targets for principal P in call X. P is a signed-in member, so no approval applies;
 * X needs none; or someone still an approver for it allowed it, its tool's
 * access still lets it, and the arguments they allowed equal X's input. The
 * decision is stored, not a proof, and this proves it again each time.
 *
 * A personal bot's call waits where its tool's policy says so, and so does
 * every call in its runs a webhook or GitHub event started, and a brief's
 * first turn follows a personal bot's rule when one wrote the brief.
 */
export interface Approved<
	P,
	X,
	Targets extends readonly unknown[],
	Operation extends ApprovedOperation,
> extends Proof<"Approved", [P, X, ...Targets]> {
	readonly operation: Operation;
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

type NamedTargets<Targets extends readonly unknown[]> = {
	[Index in keyof Targets]: Named<Targets[Index], string>;
};

export const proveApproved = <
	P,
	X,
	N extends Exclude<ApprovedOperation, "connectors.callTool">,
	I,
	const Targets extends [unknown, ...unknown[]],
>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval, N>,
	input: Named<I, InputOf<NoInfer<N>>>,
	...targets: NamedTargets<Targets>
) => proveApproval(principal, call, rule, input, targets);

export const proveComputerRequestApproved = <P, X, I, C>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	input: Named<I, InputOf<"computers.requestHost">>,
	computerUse: CanUseChatComputer<NoInfer<P>, C>,
) =>
	proveApproval(principal, call, approvalRule("computers.requestHost"), input, [computerUse.chat], {
		computerProjectId: computerUse.project,
	});

export const proveConnectorApproved = <P, X, I, T, K>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	input: Named<I, InputOf<"connectors.callTool">>,
	turn: Named<T, string>,
	connectorUse: CanUseConnector<NoInfer<P>, K>,
) =>
	proveApproval(
		principal,
		call,
		approvalRule("connectors.callTool"),
		input,
		[turn, connectorUse.reach.connector],
		{
			connectorUse,
		},
	);

const proveApproval = <
	P,
	X,
	I,
	K,
	N extends ApprovedOperation,
	const Targets extends [unknown, ...unknown[]],
>(
	principal: Named<P, Principal>,
	callNamed: Named<X, Call>,
	rule: ApprovalRule<Approval, N>,
	inputNamed: Named<I, unknown>,
	targets: NamedTargets<Targets>,
	{
		connectorUse,
		computerProjectId,
	}: {
		connectorUse?: CanUseConnector<P, K>;
		computerProjectId?: string;
	} = {},
) =>
	Effect.gen(function* () {
		const input = inputNamed.value;
		if (typeof input !== "object" || input === null) return yield* new ApprovalRefused();
		const acting = principal.value;
		if (
			!matchesApprovalTargets(
				rule.operation,
				input,
				targets.map((target) => target.value),
				acting,
			)
		)
			return yield* new ApprovalRefused();
		const inputTool = "tool" in input ? input.tool : undefined;
		if (connectorUse && inputTool !== connectorUse.tool) return yield* new ApprovalRefused();
		const usesToolArguments =
			rule.operation === "computers.useBrowser" || connectorUse !== undefined;
		const argumentsToApprove = usesToolArguments && "arguments" in input ? input.arguments : input;
		const tool =
			rule.operation === "computers.useBrowser" && typeof inputTool === "string"
				? inputTool
				: rule.tool;
		const approved = (decidedBy: string | null, sdkToolCallId: string | null = null) => {
			return ApprovedProof.prove([principal, callNamed, ...targets], {
				operation: rule.operation,
				principal,
				call: callNamed,
				decidedBy,
				sdkToolCallId,
				connectorCall: connectorUse && {
					connectorId: connectorUse.reach.connector.value,
					revision: connectorUse.reach.revision,
					tool: connectorUse.tool,
					arguments: argumentsToApprove,
				},
			});
		};
		const call = callNamed.value;
		if (
			acting._tag !== "MemberSession" &&
			acting._tag !== "BotForAsker" &&
			acting._tag !== "AutomationRun"
		) {
			return yield* new ApprovalRefused();
		}
		if (call.kind === "approvalCheck") {
			if (connectorUse?.access === "off") return yield* new ApprovalRefused();
			return yield* ApprovalCheckReached.for({
				...(computerProjectId && { computerProjectId }),
				...(connectorUse && { connectorAccess: connectorUse.access }),
				writeOrDelete: connectorUse?.writeOrDelete ?? rule.changes,
			});
		}
		if (acting._tag === "MemberSession") return approved(null);
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
			: tool;
		if (
			connectorUse &&
			(decision?.callStatus !== "running" ||
				decision.sentInExecution !== acting.executionNumber ||
				decision.connectorId !== connectorUse.reach.connector.value ||
				decision.connectorRevision !== connectorUse.reach.revision ||
				decision.remoteToolName !== connectorUse.tool ||
				(connectorUse.writeOrDelete && !decision.writeOrDelete) ||
				!sameRecordedInput(name, decision.executionInput ?? decision.input, argumentsToApprove, {
					builtIn: false,
				}))
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
			!sameRecordedInput(name, decision.executionInput ?? decision.input, argumentsToApprove, {
				builtIn: true,
			})
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

const inputTargetFields = {
	"automations.list": ["projectId"],
	"automations.updateInChat": [undefined, "automationId"],
	"bots.pin": ["botId"],
	"bots.unpin": ["botId"],
	"chats.readChatFile": ["file"],
	"chats.setResolved": ["chatId"],
	"connectors.callTool": [undefined, "connectorId"],
	"files.edit": ["fileId"],
	"files.readWritten": ["fileId"],
	"projects.addBot": ["projectId", "botId"],
	"projects.create": [undefined, "leadBotId"],
	"projects.join": ["projectId"],
} satisfies Partial<Record<ApprovedOperation, readonly (string | undefined)[]>>;

function matchesApprovalTargets(
	operation: ApprovedOperation,
	input: object,
	targets: readonly string[],
	principal: Principal,
): boolean {
	if (operation === "files.write") {
		const fileId: unknown = Reflect.get(input, "fileId");
		return fileId
			? typeof fileId === "string" && fileId.toLowerCase() === targets[0]
			: (principal._tag === "BotForAsker" || principal._tag === "AutomationRun") &&
					principal.chat === targets[0];
	}
	if (operation === "chats.searchHistory") {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") return false;
		const chat: unknown = Reflect.get(input, "chat");
		return (chat === "all" ? principal.workspace : (chat ?? principal.chat)) === targets[0];
	}
	const fields: Partial<Record<ApprovedOperation, readonly (string | undefined)[]>> =
		inputTargetFields;
	return (
		fields[operation]?.every((field, index) => {
			if (field === undefined) return true;
			const id: unknown = Reflect.get(input, field);
			return typeof id === "string" && id.toLowerCase() === targets[index]?.toLowerCase();
		}) ?? true
	);
}

/**
 * What a call needs, by its rule and the turn's: a personal bot's calls its
 * tool's policy says it asks before, since it acts across everything its
 * creator reaches, and every call in its runs that came from outside, wait for
 * its creator. An exposed tool may add its own approval rule, and a
 * connector's tool follows how that tool is configured, asking a personal
 * bot's creator before any call that may write or delete.
 */
export function approvalNeed(
	facts: TurnFacts,
	rule: ApprovalRule,
	connectorUse?: Pick<CanUseConnector<unknown, unknown>, "access" | "writeOrDelete">,
): Need {
	if (rule.approval.kind === "byToolAccess" && (!connectorUse || connectorUse.access === "off"))
		return "refused";
	const personalBotAsks = connectorUse?.writeOrDelete ?? rule.personalBotAsks;
	if (
		asksBeforeAllTools(facts) ||
		((facts.personalBotCreator !== null || facts.briefedByPersonalBot) && personalBotAsks)
	)
		return "approver";
	if (rule.approval.kind === "outsideRuns" && startedFromOutside(facts)) return "approver";
	if (
		rule.approval.kind === "outsideRunsOrMemberBounds" &&
		(startedFromOutside(facts) || hasMemberBounds(facts))
	)
		return "approver";
	return rule.approval.kind === "always" || connectorUse?.access === "ask" ? "approver" : "nothing";
}
