import { approvalsContracts } from "@sugabots/contracts/operations/approvals";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveCanDecide } from "../../proofs/can-decide.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const decide = defineOperation(approvalsContracts["approvals.decide"], (principal, input) =>
	Effect.gen(function* () {
		const controls = yield* Turns.Controls;
		return yield* named(principal, input.toolCallId, (principal, call) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				const canDecide = yield* proveCanDecide(isMember, call);
				return yield* controls.decide(isMember, canDecide, input.decision);
			}),
		);
	}),
);
