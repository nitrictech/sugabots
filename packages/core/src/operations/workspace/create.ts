import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";

export const create = defineOperation(workspaceContracts["workspaces.create"], (principal, input) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		return yield* named(principal, (principal) =>
			Effect.flatMap(proveIsMember(principal), (isMember) => membership.create(isMember, input)),
		);
	}),
);
