import {
	type AcceptedRun,
	type AutomationWebhookChallenge,
	MAX_IDEMPOTENCY_KEY_CHARACTERS,
	type WebhookAuth,
	type WebhookFilterTest,
} from "@sugabots/contracts";
import {
	AutomationDeliveryIdTooLong,
	type AutomationTriggerConflict,
	type AutomationTriggerRejected,
	WebhookRefused,
} from "@sugabots/contracts/errors/automations";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { type Database, query, transaction } from "../../database/database.ts";
import { automation, automationTrigger } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import { lockTriggers } from "./automation.ts";
import { type Delivery, deliveryIdOf, slackChallengeOf } from "./webhook-auth.ts";
import { meetsFilter } from "./webhook-filter.ts";

/**
 * What a webhook call that met its trigger's check comes to: the run it
 * started, or the one an earlier delivery of it started; a call the trigger's
 * filter turned away; or Slack's check that the address answers to it,
 * answered with its challenge. Neither of the last two starts a run.
 */
export type WebhookAnswer =
	| { readonly kind: "run"; readonly run: AcceptedRun }
	| { readonly kind: "ignored" }
	| ({ readonly kind: "challenge" } & AutomationWebhookChallenge);

/**
 * Accepts the run a call to the webhook trigger `triggerId` asks for, once the
 * webhook authenticator has checked it holds the trigger's secret. A trigger
 * that is gone, or whose automation is paused or deleted, refuses the call as
 * a bad secret would, so its address can't be probed for.
 */
export const makeAcceptWebhook = Effect.gen(function* () {
	const acceptTrigger = yield* makeAcceptTrigger;

	return (
		triggerId: string,
		delivery: Pick<Delivery, "headers" | "payload">,
	): Effect.Effect<
		WebhookAnswer,
		| WebhookRefused
		| AutomationTriggerConflict
		| AutomationTriggerRejected
		| AutomationDeliveryIdTooLong,
		Database
	> =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const found = yield* enabledWebhook(triggerId);
			if (!found) return yield* new WebhookRefused();
			const challenge = slackChallengeOf(found.auth, delivery.payload);
			if (challenge !== undefined) return { kind: "challenge" as const, challenge };
			return yield* transaction(
				Effect.gen(function* () {
					yield* lockTriggers(found.automationId);
					// The automation may have been paused, or the trigger removed, since it was read.
					const current = yield* enabledWebhook(triggerId);
					if (!current) return yield* new WebhookRefused();
					if (!meetsFilter(current.filter, delivery.payload)) return { kind: "ignored" as const };
					const idempotencyKey = deliveryIdOf(current.auth, current.deliveryIdHeader, delivery);
					if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS)
						return yield* new AutomationDeliveryIdTooLong();
					const run = yield* acceptTrigger({
						workspaceId: current.workspaceId,
						projectId: current.projectId,
						automationId: current.automationId,
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
			).pipe(Effect.catchTag("AutomationNotFound", () => Effect.fail(new WebhookRefused())));
		});
});

/** How a webhook trigger of an enabled automation checks which calls run it. */
interface EnabledWebhook {
	workspaceId: string;
	projectId: string;
	automationId: string;
	auth: WebhookAuth;
	deliveryIdHeader: string | null | undefined;
	filter: readonly WebhookFilterTest[] | undefined;
}

const enabledWebhook = (triggerId: string) =>
	Effect.map(
		isUuid(triggerId)
			? query((db) =>
					db
						.select({
							workspaceId: automation.workspaceId,
							projectId: automation.projectId,
							automationId: automation.id,
							settings: automationTrigger.settings,
						})
						.from(automationTrigger)
						.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
						.where(
							and(
								eq(automationTrigger.id, triggerId),
								eq(automationTrigger.kind, "webhook"),
								eq(automation.state, "enabled"),
								isNull(automation.pauseAfterFailuresPendingAt),
								isNull(automation.deletedAt),
							),
						)
						.limit(1),
				)
			: Effect.succeed([]),
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
