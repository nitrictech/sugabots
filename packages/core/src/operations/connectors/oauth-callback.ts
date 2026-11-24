import type { ConnectorSignInFailure, ConnectorSignInOutcome } from "@sugabots/contracts";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { defineOperation } from "../operation.ts";

/** A sign-in that ended before it was known to be for a project the caller manages. */
const failed = (failure: ConnectorSignInFailure): ConnectorSignInOutcome => ({
	kind: "failed",
	failure,
	at: undefined,
});

export const oauthCallback = defineOperation(
	connectorsContracts["connectors.oauthCallback"],
	(principal, input) =>
		Effect.gen(function* () {
			const connectors = yield* Connectors.Service;
			const { state } = input;
			if (!state) return failed("missing_state");
			const signIn = yield* connectors.signInWaitingOn(state);
			if (!signIn) return failed("unknown_state");
			return yield* named(principal, signIn.projectId, (principal, project) =>
				Effect.gen(function* () {
					// Asked again rather than carried over from the request that started
					// the sign-in, and answered as a code, not a refusal, since a browser
					// is reading it.
					const managing = yield* Effect.result(
						Effect.flatMap(proveReachesProject(principal, project), proveCanManageProject),
					);
					if (managing._tag === "Failure") return failed("not_allowed");
					return yield* connectors.finishSignIn(managing.success, signIn, { ...input, state });
				}),
			);
		}),
);
