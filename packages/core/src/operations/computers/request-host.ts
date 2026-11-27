import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { proveComputerRequestApproved } from "../../proofs/approved.ts";
import { proveCanUseChatComputer } from "../../proofs/can-use-computer.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

/**
 * A bot asking for its computer to reach another host. Those who may manage
 * the computer's project decide; their decision adds the host with their own
 * authority (see `approvals.decide`), and this reads what became of it once
 * the turn resumes. A host the workspace blocked is refused before anyone is
 * asked.
 */
export const requestHost = defineOperation(
	computersContracts["computers.requestHost"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const network = yield* ComputerNetwork.Service;
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
				return yield* new ResourceHidden({ resource: "computer" });
			}
			return yield* named(
				principal,
				principal.chat,
				call,
				input,
				(principal, chat, call, approvedInput) =>
					Effect.gen(function* () {
						const canUse = yield* proveCanUseChatComputer(principal, chat);
						yield* network.checkHostRequest(canUse, input.host);
						const approved = yield* proveComputerRequestApproved(
							principal,
							call,
							approvedInput,
							canUse,
						);
						return yield* network.requestedHost(canUse, approved);
					}),
			);
		}),
);
