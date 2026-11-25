import type { ConnectorSignInFailure, ConnectorSignInOutcome } from "@sugabots/contracts";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { proveCanManageProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesConnector } from "../../proofs/reaches-connector.ts";
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
			if (!state || principal._tag !== "MemberSession") return failed("unknown_state");
			const signIn = yield* connectors.signInWaitingOn(state, principal);
			if (!signIn) return failed("unknown_state");
			return yield* named(
				principal,
				signIn.projectId,
				signIn.connectorId,
				(principal, project, connector) =>
					Effect.gen(function* () {
						// Asked again rather than carried over from the request that started
						// the sign-in, and answered as a code, not a refusal, since a browser
						// is reading it.
						const access = yield* Effect.result(
							Effect.gen(function* () {
								const { reach, target } = yield* proveReachesConnector(
									principal,
									project,
									connector,
								);
								const canManage = yield* proveCanManageProject(reach);
								return { canManage, target };
							}),
						);
						if (access._tag === "Failure") return failed("unknown_state");
						const { canManage, target } = access.success;
						return yield* connectors.finishSignIn(canManage, connector, target, {
							...input,
							state,
						});
					}),
			);
		}),
);
