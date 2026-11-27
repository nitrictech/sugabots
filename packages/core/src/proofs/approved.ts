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
import {
	ApprovalCheckReached,
	type Call,
	type ResolvedTargets,
	sameResolvedTargets,
} from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import type { CanUseChatComputer } from "./can-use-computer.ts";
import type { CanUseConnector } from "./can-use-connector.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { toolIsOn, toolSwitchedOff, toolSwitchFor } from "./tool-switches.ts";

export type ApprovedOperation =
	| BotLoopOperationName<typeof operationContracts>
	| "automations.list";

export type ComputerOperation = Exclude<
	Extract<ApprovedOperation, `computers.${string}`>,
	"computers.requestHost"
>;

export type OrdinaryOperation = Exclude<
	ApprovedOperation,
	"connectors.callTool" | "computers.requestHost" | ComputerOperation
>;

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
 * X needs none; or an approver allowed it, its tool's
 * access still lets it, and the arguments they allowed equal X's input. The
 * stored decision is checked against the call each time.
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
	/**
	 * The input this was proved for, which the approval covers: a service
	 * takes the values it acts on from here, so it never acts on others.
	 */
	readonly input: InputOf<Operation>;
	/** The member who allowed it; none when it needed no one. */
	readonly decidedBy: string | null;
	readonly computer: ComputerApprovalTarget | undefined;
	readonly sdkToolCallId: string | null;
	readonly resolvedTargets: ResolvedTargets | undefined;
	readonly connectorCall:
		| {
				readonly connectorId: string;
				readonly revision: number;
				readonly tool: string;
				readonly arguments: unknown;
		  }
		| undefined;
}

export type ComputerApprovalTarget = Pick<
	CanUseChatComputer<unknown, unknown>,
	"provider" | "computer" | "machine"
>;
type ComputerUse<P> = ComputerApprovalTarget & Pick<CanUseChatComputer<P, unknown>, "principal">;

export function computerApprovalTarget({
	provider,
	computer,
	machine,
}: ComputerApprovalTarget): ComputerApprovalTarget {
	return { provider, computer, machine };
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
	N extends OrdinaryOperation,
	I,
	const Targets extends [unknown, ...unknown[]],
>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval, N>,
	input: Named<I, InputOf<NoInfer<N>>>,
	...targets: NamedTargets<Targets>
) => proveApproval(principal, call, rule, input, targets);

/**
 * `proveApproved` for a call whose names and ids stood for `resolvedTargets`
 * when it was checked: an approval given while they stood for others, such as
 * a handle that named another bot, or another computer since replaced, no
 * longer covers it, and the call waits for a fresh one.
 */
export const proveApprovedAsResolved = <
	P,
	X,
	N extends OrdinaryOperation,
	I,
	const Targets extends [unknown, ...unknown[]],
>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval, N>,
	input: Named<I, InputOf<NoInfer<N>>>,
	resolvedTargets: ResolvedTargets,
	...targets: NamedTargets<Targets>
) => proveApproval(principal, call, rule, input, targets, { resolvedTargets });

/**
 * `proveApproved` for a bot's work on its chat's computer, as `computerUse`
 * proved it: an approval covers the computer the project had when it was
 * given, on the machine it was on then, not one made since in its place, nor
 * the same computer its provider has since recovered or upgraded onto another
 * machine.
 */
export const proveComputerUseApproved = <P, X, N extends ComputerOperation, I, C>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	rule: ApprovalRule<OrdinaryApproval, N>,
	input: Named<I, InputOf<NoInfer<N>>>,
	computerUse: CanUseChatComputer<NoInfer<P>, C>,
	resolveTarget?: Effect.Effect<ResolvedTargets, ApprovalRefused>,
) =>
	proveApproval(principal, call, rule, input, [computerUse.chat], { computerUse, resolveTarget });

/**
 * `proveApproved` for a bot's request to reach a host, bound to the project
 * whose computer it asked from, not to that computer: allowing it adds the
 * host to the project's allowed hosts, which are the project's policy for
 * whatever computer it has, so the grant outlasts a reset. Whoever decides
 * must manage the project, and the bot that asked must still be able to use
 * its computer when they do.
 */
export const proveComputerRequestApproved = <P, X, I, C>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	input: Named<I, InputOf<"computers.requestHost">>,
	computerUse: CanUseChatComputer<NoInfer<P>, C>,
) =>
	computerUse.principal.value === principal.value
		? proveApproval(
				principal,
				call,
				approvalRule("computers.requestHost"),
				input,
				[computerUse.chat],
				{
					computerProjectId: computerUse.project,
				},
			)
		: Effect.fail(new ApprovalRefused());

export const proveConnectorApproved = <P, X, I, T, K, C>(
	principal: Named<P, Principal>,
	call: Named<X, Call>,
	input: Named<I, InputOf<"connectors.callTool">>,
	turn: Named<T, string>,
	connectorUse: CanUseConnector<NoInfer<P>, K>,
	{
		computerUse,
		resolvedTargets,
	}: {
		computerUse?: CanUseChatComputer<NoInfer<P>, C>;
		resolvedTargets?: ResolvedTargets | null | undefined;
	} = {},
) =>
	proveApproval(
		principal,
		call,
		approvalRule("connectors.callTool"),
		input,
		[turn, connectorUse.reach.connector],
		{
			connectorUse,
			computerUse,
			resolveTarget:
				resolvedTargets === undefined
					? undefined
					: resolvedTargets === null
						? Effect.fail(new ApprovalRefused())
						: Effect.succeed({
								...(computerUse && computerApprovalTarget(computerUse)),
								...resolvedTargets,
							}),
		},
	);

export const needsConnectorApprovalTargets = (turnId: string, call: Call) => {
	if (call.kind === "approvalCheck") return Effect.succeed(true);
	if (call.kind !== "toolCall" || !isUuid(call.toolCall)) return Effect.succeed(false);
	return Effect.map(
		readRecordedCall(turnId, call.toolCall),
		(decision) => decision?.status === "allowed",
	);
};

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
	inputNamed: Named<I, InputOf<N>>,
	targets: NamedTargets<Targets>,
	{
		connectorUse,
		computerUse,
		computerProjectId,
		resolvedTargets: otherTargets,
		resolveTarget,
	}: {
		connectorUse?: CanUseConnector<P, K>;
		computerUse?: ComputerUse<NoInfer<P>> | undefined;
		computerProjectId?: string;
		resolvedTargets?: ResolvedTargets;
		resolveTarget?: Effect.Effect<ResolvedTargets, ApprovalRefused> | undefined;
	} = {},
) =>
	Effect.gen(function* () {
		if (computerUse && computerUse.principal.value !== principal.value)
			return yield* new ApprovalRefused();
		const computer = computerUse && computerApprovalTarget(computerUse);
		const resolveApprovalTargets =
			resolveTarget ??
			(rule.operation === "computers.useBrowser"
				? Effect.fail(new ApprovalRefused())
				: Effect.succeed(computer ?? otherTargets));
		const input: InputOf<N> = inputNamed.value;
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
		const approved = (
			decidedBy: string | null,
			sdkToolCallId: string | null = null,
			resolvedTargets?: ResolvedTargets,
		) => {
			return ApprovedProof.prove([principal, callNamed, ...targets], {
				operation: rule.operation,
				principal,
				call: callNamed,
				input,
				decidedBy,
				computer: decidedBy === null ? undefined : computer,
				sdkToolCallId,
				resolvedTargets,
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
		// A tool switched off since the step offered it does nothing, nor waits for approval.
		const toolSwitch = toolSwitchFor(rule.operation);
		if (
			toolSwitch &&
			acting._tag !== "MemberSession" &&
			!(yield* query((db) => toolIsOn(db, acting.bot, toolSwitch)))
		) {
			return yield* toolSwitchedOff(toolSwitch);
		}
		if (call.kind === "approvalCheck") {
			if (connectorUse?.access === "off") return yield* new ApprovalRefused();
			const resolvedTargets = call.forDecision ? otherTargets : yield* resolveApprovalTargets;
			return yield* ApprovalCheckReached.for({
				...(computerProjectId && { computerProjectId }),
				...(call.forDecision && computer && { computerTarget: computer }),
				...(resolvedTargets && { resolvedTargets }),
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
		const decision = yield* readRecordedCall(acting.turn, call.toolCall);
		const resolvedTargets =
			decision?.status === "allowed" ? yield* resolveApprovalTargets : undefined;
		const recorded = decideRecordedCall(decision, {
			need,
			name: connectorUse ? connectorToolKey(connectorUse.reach.handle, connectorUse.tool) : tool,
			executionNumber: acting.executionNumber,
			argumentsToApprove,
			connectorUse,
			computerProjectId,
			resolvedTargets,
		});
		if (recorded === "refused") return yield* new ApprovalRefused();
		if (recorded === "needed") return yield* new ApprovalNeeded();
		return approved(recorded, decision?.sdkToolCallId, resolvedTargets);
	});

const readRecordedCall = (turnId: string, callId: string) =>
	query((db) =>
		db
			.select({
				tool: toolCall.tool,
				computerProjectId: toolCall.approvalComputerProjectId,
				resolvedTargets: toolCall.approvalResolvedTargets,
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
			.where(and(eq(toolCall.id, callId), eq(toolCall.turnId, turnId)))
			.limit(1),
	).pipe(Effect.map(([recorded]) => recorded));

function decideRecordedCall<P, K>(
	decision: Effect.Success<ReturnType<typeof readRecordedCall>>,
	{
		need,
		name,
		executionNumber,
		argumentsToApprove,
		connectorUse,
		computerProjectId,
		resolvedTargets,
	}: {
		need: Exclude<Need, "refused">;
		name: string;
		executionNumber: number;
		argumentsToApprove: unknown;
		connectorUse: CanUseConnector<P, K> | undefined;
		computerProjectId: string | undefined;
		resolvedTargets: ResolvedTargets | undefined;
	},
) {
	if (
		connectorUse &&
		(decision?.callStatus !== "running" ||
			decision.sentInExecution !== executionNumber ||
			decision.connectorId !== connectorUse.reach.connector.value ||
			decision.connectorRevision !== connectorUse.reach.revision ||
			decision.remoteToolName !== connectorUse.tool ||
			(connectorUse.writeOrDelete && !decision.writeOrDelete) ||
			!sameRecordedInput(name, decision.executionInput ?? decision.input, argumentsToApprove, {
				builtIn: false,
			}))
	)
		return "refused";
	if (
		decision &&
		(decision.tool !== name ||
			decision.status === "denied" ||
			(decision.status === "allowed" &&
				computerProjectId !== undefined &&
				computerProjectId !== decision.computerProjectId))
	)
		return "refused";
	if (need === "nothing" && !decision?.status) return null;
	// A connector call's input was compared with what was recorded above.
	if (
		!connectorUse &&
		decision?.status === "allowed" &&
		!sameRecordedInput(name, decision.executionInput ?? decision.input, argumentsToApprove, {
			builtIn: true,
		})
	) {
		return "refused";
	}
	if (
		decision?.status !== "allowed" ||
		!decision.decidedBy ||
		!sameResolvedTargets(decision.resolvedTargets, resolvedTargets) ||
		(connectorUse?.access === "ask" && decision.accessAtApproval !== "ask")
	) {
		return "needed";
	}
	return decision.decidedBy;
}

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
