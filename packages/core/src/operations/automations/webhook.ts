import { automationsContracts } from "@sugabots/contracts/operations/automations";
import { Effect } from "effect";
import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { proveCallsWebhook } from "../../proofs/calls-webhook.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const webhook = defineOperation(
	automationsContracts["automations.webhook"],
	(principal, input) =>
		Effect.gen(function* () {
			const automations = yield* ProjectAutomations.Service;
			const { headers, payload } = input;
			const answer = yield* named(principal, input.triggerId, (principal, trigger) =>
				Effect.flatMap(proveCallsWebhook(principal, trigger), (calls) =>
					automations.acceptWebhook(calls, { headers, payload }),
				),
			);
			switch (answer.kind) {
				case "run":
					return { runId: answer.run.runId, duplicate: answer.run.duplicate };
				case "ignored":
					return { ignored: true as const };
				case "challenge":
					return { challenge: answer.challenge };
			}
		}),
);
