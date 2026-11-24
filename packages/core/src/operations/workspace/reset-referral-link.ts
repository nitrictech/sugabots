import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Accounts } from "../../accounts/accounts.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const resetReferralLink = defineOperation(
	workspaceContracts["referrals.resetLink"],
	(principal) =>
		Effect.gen(function* () {
			const accounts = yield* Accounts.Service;
			return yield* named(principal, (principal) =>
				Effect.flatMap(proveIsMember(principal), (isMember) =>
					Effect.map(accounts.resetReferralLink(isMember), (url) => ({ url })),
				),
			);
		}),
);
