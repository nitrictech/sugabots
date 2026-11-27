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
	type ComputerOperation,
	type OrdinaryApproval,
	proveComputerUseApproved,
} from "../../proofs/approved.ts";
import { proveCanUseChatComputer } from "../../proofs/can-use-computer.ts";
import { named } from "../../proofs/proof.ts";
import { type Call, defineOperation } from "../operation.ts";

/**
 * A bot's work on its computer: the computer of the project its turn's chat
 * is in. Each call proves the bot may use it, as `CanUseChatComputer`
 * decides, and that the call may run under the tool and turn's approval rules
 * before it does `work`, as `proveComputerUseApproved` decides.
 * Any principal but a bot in a turn reaches no computer this way.
 */
const usingComputer = <N extends ComputerOperation, A, E, R>(
	principal: Principal,
	call: Call,
	rule: ApprovalRule<OrdinaryApproval, N>,
	approvalInput: InputOf<NoInfer<N>>,
	work: <P, C, X>(
		step: TurnComputers.CheckedStep<P, C>,
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
					const step = yield* computers.checkStep(canUse);
					const approved = yield* proveComputerUseApproved(
						principal,
						call,
						rule,
						approvedInput,
						canUse,
					);
					return yield* work(step, approved);
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
				(step, approved) => computers.runCommand(step, approved),
			),
		),
);

export const readFile = defineOperation(
	computersContracts["computers.readFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(principal, call, approvalRule("computers.readFile"), input, (step, approved) =>
				computers.readFile(step, approved),
			),
		),
);

export const writeFile = defineOperation(
	computersContracts["computers.writeFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(principal, call, approvalRule("computers.writeFile"), input, (step, approved) =>
				computers.writeFile(step, approved),
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
				(step, approved) => computers.copyChatFile(step, approved),
			),
		),
);

export const shareFile = defineOperation(
	computersContracts["computers.shareFile"],
	(principal, input, call) =>
		Effect.flatMap(TurnComputers.Service, (computers) =>
			usingComputer(principal, call, approvalRule("computers.shareFile"), input, (step, approved) =>
				computers.shareFile(step, approved),
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
				(step, approved) => computers.useBrowser(step, approved),
			),
		),
);
