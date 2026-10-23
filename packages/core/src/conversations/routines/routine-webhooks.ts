import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
	MAX_IDEMPOTENCY_KEY_CHARACTERS,
	type WebhookAuth,
	type WebhookCondition,
} from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { routine, routineTrigger } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineDeliveryIdTooLong } from "./routine.ts";
import type { Routines } from "./routines.ts";
import {
	type Delivery,
	deliveryAuthentic,
	deliveryIdOf,
	presentedSecret,
	slackChallengeOf,
} from "./webhook-auth.ts";
import { meetsFilter } from "./webhook-filter.ts";

/** Runs a webhook trigger's caller asks for: `Routines.Webhooks`. */
export const makeWebhooks = Effect.gen(function* () {
	const operation = yield* serviceOperations<Routines.WebhooksInterface>("Routines.Webhooks");
	const acceptTrigger = yield* makeAcceptTrigger;
	const credentials = yield* Credentials.Service;

	const authentic = (webhook: EnabledWebhook, delivery: Delivery, now: Date) => {
		// Left without a secret on purpose, so its address alone runs it.
		if (webhook.secret === null && webhook.digest === null) return Effect.succeed(true);
		if (webhook.secret !== null) {
			const secret = credentials.decrypt(webhook.secret);
			return Effect.succeed(deliveryAuthentic(webhook.auth, secret, delivery, now));
		}
		const { auth, digest } = webhook;
		const presented = auth.kind === "bearer" ? presentedSecret(auth, delivery.headers) : undefined;
		if (presented === undefined || digest === null) return Effect.succeed(false);
		return Effect.promise(() => verifyLegacySecret(presented, digest));
	};

	return {
		accept: ({ triggerId, delivery }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					// Checked before the routine's trigger lock is taken, so a caller
					// without the secret cannot hold up its other triggers.
					const found = isUuid(triggerId) ? yield* enabledWebhook(triggerId) : undefined;
					if (!found || !(yield* authentic(found, delivery, now))) return undefined;
					const challenge = slackChallengeOf(found.auth, delivery.payload);
					if (challenge !== undefined) return { kind: "challenge" as const, challenge };
					if (!meetsFilter(found.filter, delivery.payload)) return { kind: "ignored" as const };
					const idempotencyKey = deliveryIdOf(delivery);
					if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
						return yield* new RoutineDeliveryIdTooLong();
					}
					return yield* transaction(
						Effect.gen(function* () {
							yield* lockTriggers(found.routineId);
							// How callers are checked may have changed while this one was.
							const current = yield* enabledWebhook(triggerId);
							if (!current || !sameCheck(current, found)) return undefined;
							const execution = yield* acceptTrigger({
								workspaceId: found.workspaceId,
								agentId: found.agentId,
								routineId: found.routineId,
								triggerId,
								triggerIdentity: idempotencyKey,
								trigger: {
									kind: "webhook",
									idempotencyKey,
									payload: delivery.payload,
									receivedAt: now.toISOString(),
								},
							});
							return { kind: "run" as const, execution };
						}),
					).pipe(Effect.catchTag("RoutineNotFound", () => Effect.undefined));
				}),
			),
	} satisfies Routines.WebhooksInterface;
});

/** What a webhook trigger of an enabled routine checks its callers with. */
interface EnabledWebhook {
	workspaceId: string;
	agentId: string;
	routineId: string;
	auth: WebhookAuth;
	filter: readonly WebhookCondition[] | undefined;
	/** Sealed with `Credentials`. */
	secret: string | null;
	/** The hash of a bearer secret made before secrets were sealed. */
	digest: string | null;
}

const enabledWebhook = (triggerId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({
					workspaceId: routine.workspaceId,
					agentId: routine.agentId,
					routineId: routine.id,
					settings: routineTrigger.settings,
					secret: routineTrigger.secretEncrypted,
					digest: routineTrigger.secretDigest,
				})
				.from(routineTrigger)
				.innerJoin(routine, eq(routine.id, routineTrigger.routineId))
				.where(
					and(
						eq(routineTrigger.id, triggerId),
						eq(routineTrigger.kind, "webhook"),
						eq(routine.state, "enabled"),
						isNull(routine.deletedAt),
					),
				)
				.limit(1),
		),
		([row]): EnabledWebhook | undefined => {
			if (row?.settings.kind !== "webhook") return undefined;
			const { settings, ...rest } = row;
			return { ...rest, auth: settings.auth, filter: settings.filter };
		},
	);

/** Whether two reads of a trigger check callers the same way, with the same secret. */
function sameCheck(a: EnabledWebhook, b: EnabledWebhook): boolean {
	return (
		a.secret === b.secret &&
		a.digest === b.digest &&
		JSON.stringify(a.auth) === JSON.stringify(b.auth)
	);
}

const deriveKey = promisify(scrypt);

/** Checks `secret` against an `scrypt:{salt}:{digest}` hash, off the event loop since scrypt is slow on purpose. */
async function verifyLegacySecret(secret: string, encoded: string) {
	const [algorithm, saltText, digestText] = encoded.split(":");
	if (algorithm !== "scrypt" || !saltText || !digestText) return false;
	try {
		const expected = Buffer.from(digestText, "base64url");
		const actual = Buffer.from(
			(await deriveKey(secret, Buffer.from(saltText, "base64url"), expected.length)) as ArrayBuffer,
		);
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}
