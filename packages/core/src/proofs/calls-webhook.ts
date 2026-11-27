import { WebhookRefused } from "@sugabots/contracts/errors/automations";
import { Effect } from "effect";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a call to the webhook trigger T that the webhook authenticator
 * accepted: signed with T's secret, or sent to T left without one. It reaches
 * T's automation and nothing else. Whether the automation is on, and whether
 * the call meets T's filter, is for accepting its run to decide.
 */
export interface CallsWebhook<P, T> extends Proof<"CallsWebhook", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly trigger: Named<T, string>;
	/** T's workspace, project and automation, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	readonly automation: string;
}

const CallsWebhookProof = defineProof("CallsWebhook");

export const proveCallsWebhook = <P, T>(
	principal: Named<P, Principal>,
	triggerId: Named<T, string>,
): Effect.Effect<CallsWebhook<P, T>, WebhookRefused> => {
	const acting = principal.value;
	if (
		acting._tag !== "WebhookCall" ||
		acting.source.kind !== "trigger" ||
		acting.source.trigger !== triggerId.value
	) {
		return Effect.fail(new WebhookRefused());
	}
	const { source } = acting;
	const proof: CallsWebhook<P, T> = CallsWebhookProof.prove([principal, triggerId], {
		principal,
		trigger: triggerId,
		workspace: acting.workspace,
		project: source.project,
		automation: source.automation,
	});
	return Effect.succeed(proof);
};
