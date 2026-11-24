import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a delivery the GitHub app of the GitHub connector K signed: a webhook
 * call its authenticator admitted with K's app's webhook secret. Anyone else,
 * another connector's app included, is hidden from K's deliveries.
 */
export interface SignedByGitHubApp<P, K> extends Proof<"SignedByGitHubApp", [P, K]> {
	readonly principal: Named<P, Principal>;
	readonly connector: Named<K, string>;
	/** K's workspace and project, which services take from here. */
	readonly workspace: string;
	readonly project: string;
}

const SignedByGitHubAppProof = defineProof("SignedByGitHubApp");

export const proveSignedByGitHubApp = <P, K>(
	principal: Named<P, Principal>,
	connectorId: Named<K, string>,
): Effect.Effect<SignedByGitHubApp<P, K>, ResourceHidden> => {
	const acting = principal.value;
	const signedByIt =
		acting._tag === "WebhookCall" &&
		acting.source.kind === "github" &&
		acting.source.connector === connectorId.value;
	if (!signedByIt) return Effect.fail(new ResourceHidden({ resource: "connector" }));
	const proof: SignedByGitHubApp<P, K> = SignedByGitHubAppProof.prove([principal, connectorId], {
		principal,
		connector: connectorId,
		workspace: acting.workspace,
		project: acting.source.project,
	});
	return Effect.succeed(proof);
};
