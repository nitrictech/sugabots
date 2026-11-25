import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { TurnComputers } from "../../chats/tools/computer/turn-computers.ts";
import type { Principal } from "../../principal.ts";
import {
	type ApprovalRule,
	type Approved,
	approvalRule,
	type OrdinaryApproval,
	proveApproved,
} from "../../proofs/approved.ts";
import { type CanUseChatComputer, proveCanUseChatComputer } from "../../proofs/can-use-computer.ts";
import { named } from "../../proofs/proof.ts";
import { type Call, defineOperation } from "../operation.ts";

type ComputerOperation =
	| "computers.runCommand"
	| "computers.readFile"
	| "computers.writeFile"
	| "computers.copyChatFile"
	| "computers.shareFile"
	| "computers.useBrowser";

/**
 * A bot's work on its computer: the computer of the project its turn's chat
 * is in. Each call proves the bot may use it, as `CanUseChatComputer`
 * decides, and that the call may run under the tool and turn's approval rules
 * before it does `work`.
 * Any principal but a bot in a turn reaches no computer this way.
 */
const usingComputer = <N extends ComputerOperation, A, E, R>(
	principal: Principal,
	call: Call,
	rule: ApprovalRule<OrdinaryApproval, N>,
	approvalInput: InputOf<NoInfer<N>>,
	work: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], N>,
	) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return yield* new ResourceHidden({ resource: "computer" });
		}
		return yield* named(
			principal,
			principal.chat,
			call,
			approvalInput,
			(principal, chat, call, approvedInput) =>
				Effect.gen(function* () {
					const canUse = yield* proveCanUseChatComputer(principal, chat);
					const computers = yield* TurnComputers.Service;
					yield* computers.requireComputer(canUse);
					const approved = yield* proveApproved(principal, call, rule, approvedInput, chat);
					return yield* work(canUse, approved);
				}),
		);
	});

export const runCommand = defineOperation(
	computersContracts["computers.runCommand"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.runCommand"),
				input,
				(canUse, approved) => computers.runCommand(canUse, approved, input),
			),
		),
);

export const readFile = defineOperation(
	computersContracts["computers.readFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.readFile"),
				input,
				(canUse, approved) => computers.readFile(canUse, approved, input),
			),
		),
);

export const writeFile = defineOperation(
	computersContracts["computers.writeFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.writeFile"),
				input,
				(canUse, approved) => computers.writeFile(canUse, approved, input),
			),
		),
);

export const copyChatFile = defineOperation(
	computersContracts["computers.copyChatFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.copyChatFile"),
				input,
				(canUse, approved) => computers.copyChatFile(canUse, approved, input),
			),
		),
);

export const shareFile = defineOperation(
	computersContracts["computers.shareFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.shareFile"),
				input,
				(canUse, approved) => computers.shareFile(canUse, approved, input),
			),
		),
);

/**
 * One call to a browser tool. The call was recorded, and any approval asked
 * for, under the browser tool's own name with the arguments the model gave
 * it, so its approval is proved the same way.
 */
export const useBrowser = defineOperation(
	computersContracts["computers.useBrowser"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(
				principal,
				call,
				approvalRule("computers.useBrowser"),
				input,
				(canUse, approved) => computers.useBrowser(canUse, approved, input),
			),
		),
);
