import {
	MAX_IDEMPOTENCY_KEY_CHARACTERS,
	type WebhookAuth,
	type WebhookCondition,
} from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { automation, automationTrigger } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { AutomationDeliveryIdTooLong } from "./automation.ts";
import type { Automations } from "./automations.ts";
import {
	type Delivery,
	deliveryAuthentic,
	deliveryIdOf,
	slackChallengeOf,
} from "./webhook-auth.ts";
import { meetsFilter } from "./webhook-filter.ts";

/** Runs a webhook trigger's caller asks for: `Automations.Webhooks`. */
export const makeWebhooks = Effect.gen(function* () {
	const operation = yield* serviceOperations<Automations.WebhooksInterface>("Automations.Webhooks");
	const acceptTrigger = yield* makeAcceptTrigger;
	const credentials = yield* Credentials.Service;

	const authentic = (webhook: EnabledWebhook, delivery: Delivery, now: Date) => {
		// Left without a secret on purpose, so its address alone runs it.
		if (webhook.secret === null) return true;
		return deliveryAuthentic(webhook.auth, credentials.decrypt(webhook.secret), delivery, now);
	};

	return {
		accept: ({ triggerId, delivery }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					// Checked before the automation's trigger lock is taken, so a caller
					// without the secret cannot hold up its other triggers.
					const found = isUuid(triggerId) ? yield* enabledWebhook(triggerId) : undefined;
					if (!found || !authentic(found, delivery, now)) return undefined;
					const challenge = slackChallengeOf(found.auth, delivery.payload);
					if (challenge !== undefined) return { kind: "challenge" as const, challenge };
					return yield* transaction(
						Effect.gen(function* () {
							yield* lockTriggers(found.automationId);
							// How callers are checked may have changed while this one was.
							const current = yield* enabledWebhook(triggerId);
							if (!current || !sameCheck(current, found)) return undefined;
							if (!meetsFilter(current.filter, delivery.payload))
								return { kind: "ignored" as const };
							const idempotencyKey = deliveryIdOf(current.auth, current.deliveryIdHeader, delivery);
							if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS)
								return yield* new AutomationDeliveryIdTooLong();
							const run = yield* acceptTrigger({
								workspaceId: found.workspaceId,
								projectId: found.projectId,
								automationId: found.automationId,
								triggerId,
								triggerIdentity: idempotencyKey,
								trigger: {
									kind: "webhook",
									idempotencyKey,
									payload: delivery.payload,
									receivedAt: now.toISOString(),
								},
							});
							return { kind: "run" as const, run };
						}),
					).pipe(Effect.catchTag("AutomationNotFound", () => Effect.undefined));
				}),
			),
	} satisfies Automations.WebhooksInterface;
});

/** What a webhook trigger of an enabled automation checks its callers with. */
interface EnabledWebhook {
	workspaceId: string;
	projectId: string;
	automationId: string;
	auth: WebhookAuth;
	/** Where a generic webhook's delivery id is, if anywhere. */
	deliveryIdHeader: string | null | undefined;
	filter: readonly WebhookCondition[] | undefined;
	/** Sealed with `Credentials`. */
	secret: string | null;
}

const enabledWebhook = (triggerId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({
					workspaceId: automation.workspaceId,
					projectId: automation.projectId,
					automationId: automation.id,
					settings: automationTrigger.settings,
					secret: automationTrigger.secretEncrypted,
				})
				.from(automationTrigger)
				.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
				.where(
					and(
						eq(automationTrigger.id, triggerId),
						eq(automationTrigger.kind, "webhook"),
						eq(automation.state, "enabled"),
						isNull(automation.deletedAt),
					),
				)
				.limit(1),
		),
		([row]): EnabledWebhook | undefined => {
			if (row?.settings.kind !== "webhook") return undefined;
			const { settings, ...rest } = row;
			return {
				...rest,
				auth: settings.auth,
				deliveryIdHeader: settings.deliveryIdHeader,
				filter: settings.filter,
			};
		},
	);

/** Whether two reads of a trigger check callers the same way, with the same secret. */
function sameCheck(a: EnabledWebhook, b: EnabledWebhook): boolean {
	return a.secret === b.secret && JSON.stringify(a.auth) === JSON.stringify(b.auth);
}
