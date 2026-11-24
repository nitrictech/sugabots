import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { named } from "../../../proofs/proof.ts";
import { proveSignedByGitHubApp } from "../../../proofs/signed-by-github-app.ts";
import { GitHubConnectors } from "../../../providers/connectors/github/github-connectors.ts";
import { defineOperation } from "../../operation.ts";

export const delivery = defineOperation(
	connectorsContracts["gitHubWebhooks.delivery"],
	(principal, input) =>
		Effect.gen(function* () {
			const gitHubConnectors = yield* GitHubConnectors.Service;
			const { connectorId, ...delivered } = input;
			return yield* named(principal, connectorId, (principal, connector) =>
				Effect.flatMap(proveSignedByGitHubApp(principal, connector), (signed) =>
					gitHubConnectors.readDelivery(signed, delivered),
				),
			);
		}),
);
