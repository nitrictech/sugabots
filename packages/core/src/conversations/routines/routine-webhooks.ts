export * as RoutineWebhooks from "./routine-webhooks.ts";

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AcceptedRoutineExecution, RoutineExecutionTrigger } from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { routine } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import type { RoutineTriggerConflict, RoutineTriggerRejected } from "./routine.ts";

/**
 * Runs a webhook routine's caller asks for. Nobody signs in to call one: the
 * secret the routine was given is what admits the run, so this asks for no
 * actor, and is the one routine operation a route calls without one.
 */
export interface Interface {
	/**
	 * Accepts a webhook's run, if `secret` is the routine's. `undefined` when
	 * it is not, or there is no such enabled webhook routine: the caller is
	 * told the same either way.
	 */
	readonly accept: (delivery: {
		routineId: string;
		secret: Redacted.Redacted<string>;
		trigger: Extract<RoutineExecutionTrigger, { kind: "webhook" }>;
	}) => Effect.Effect<
		AcceptedRoutineExecution | undefined,
		RoutineTriggerConflict | RoutineTriggerRejected
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/RoutineWebhooks",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineWebhooks");
	const acceptTrigger = yield* makeAcceptTrigger;
	return Service.of({
		accept: ({ routineId, secret, trigger }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					// Checked before the routine's trigger lock is taken, so a caller
					// without the secret cannot hold up its other triggers while the
					// deliberately slow hash runs.
					const found = isUuid(routineId) ? yield* enabledWebhook(routineId) : undefined;
					const valid = yield* Effect.promise(() =>
						verifySecret(Redacted.value(secret), found?.digest ?? DUMMY_SECRET_DIGEST),
					);
					if (!valid || !found) return undefined;
					return yield* transaction(
						Effect.gen(function* () {
							yield* lockTriggers(routineId);
							// The secret may have been replaced while it was being checked.
							const current = yield* enabledWebhook(routineId);
							if (current?.digest !== found.digest) return undefined;
							return yield* acceptTrigger({
								workspaceId: found.workspaceId,
								agentId: found.agentId,
								routineId,
								triggerIdentity: trigger.idempotencyKey,
								trigger,
							});
						}),
					).pipe(Effect.catchTag("RoutineNotFound", () => Effect.undefined));
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([RoutineRepository.layer, ThreadRepository.layer]),
);

/** A new webhook secret, which is shown once and stored only as {@link hashSecret}. */
export function generateSecret() {
	return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string) {
	const salt = randomBytes(16);
	const digest = scryptSync(secret, salt, 32);
	return `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

const enabledWebhook = (routineId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({
					digest: routine.webhookSecretDigest,
					workspaceId: routine.workspaceId,
					agentId: routine.agentId,
				})
				.from(routine)
				.where(
					and(
						eq(routine.id, routineId),
						eq(routine.triggerKind, "webhook"),
						eq(routine.state, "enabled"),
						isNull(routine.deletedAt),
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

const deriveKey = promisify(scrypt);

/** Checked against when there is no routine, so a missing one takes as long to refuse. */
const DUMMY_SECRET_DIGEST = hashSecret("not-a-routine-secret");

async function verifySecret(secret: string, encoded: string) {
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
