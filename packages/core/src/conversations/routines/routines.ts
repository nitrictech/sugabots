export * as Routines from "./routines.ts";

import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineUpdate,
} from "@sugabots/contracts";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { routine } from "../../database/schema.ts";
import type { AuthorizationDenied } from "../../workspaces/access.ts";
import { Authorization } from "../../workspaces/authorization.ts";
import type { CurrentActor } from "../../workspaces/current-actor.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	type OnAgent,
	RoutineNotFound,
	type RoutineTriggerConflict,
	RoutineTriggerRejected,
	scopeOf,
	toRoutine,
} from "./routine.ts";
import { generateSecret, hashSecret } from "./routine-webhooks.ts";
import { type InvalidRoutineSchedule, nextOccurrence, upcomingOccurrences } from "./schedule.ts";

/**
 * The routines people define on a crew agent, and running one when asked,
 * as the current actor with the permission its agent's pod gives them. Each
 * run is in its own thread in the agent's chat.
 *
 * Runs nobody asks for, on a webhook or a schedule, are `RoutineWebhooks` and
 * `RoutineRunner`; a run is started by its workflow, one at a time per
 * routine, and ended by `RoutineSettlement`.
 */
export interface Interface {
	/**
	 * Defines a routine on a crew agent. A webhook routine's secret is
	 * returned once, here, and never again.
	 */
	readonly create: (
		owner: { agentId: string },
		input: NewRoutine,
	) => Effect.Effect<
		Defined,
		AuthorizationDenied | RoutineRepository.RoutineNameTaken | InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	/** Changes a routine. Switching it to a webhook returns its new secret. */
	readonly update: (
		routine: OnAgent,
		input: RoutineUpdate,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineNotFound
		| RoutineRepository.RoutineNameTaken
		| InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	readonly remove: (
		routine: OnAgent,
	) => Effect.Effect<void, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/** A new secret for a webhook routine, replacing the old one. */
	readonly rotateSecret: (
		routine: OnAgent,
	) => Effect.Effect<
		string,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * When a schedule would run next, for somebody choosing one for the
	 * agent's routines.
	 */
	readonly previewSchedule: (input: {
		agentId: string;
		expression: string;
		timezone: string;
	}) => Effect.Effect<Date[], AuthorizationDenied | InvalidRoutineSchedule, CurrentActor.Service>;
	/**
	 * Runs the routine now, for the actor: opens its thread, posts the
	 * trigger, and queues the run. Asking again with the same `requestId`
	 * returns that run again, as a duplicate.
	 */
	readonly run: (
		routine: OnAgent & { requestId: string },
	) => Effect.Effect<
		AcceptedRoutineExecution,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Routines") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Routines");
	const authorization = yield* Authorization.Service;
	const repository = yield* RoutineRepository.Service;
	const acceptTrigger = yield* makeAcceptTrigger;

	return Service.of({
		create: ({ agentId }, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.manage");
					const state = input.state ?? "enabled";
					const schedule =
						input.trigger.kind === "cron" && state === "enabled"
							? yield* nextOccurrence(
									input.trigger.expression,
									input.trigger.timezone,
									yield* DateTime.nowAsDate,
								)
							: null;
					const secret = input.trigger.kind === "webhook" ? generateSecret() : null;
					return yield* transaction(
						Effect.gen(function* () {
							const row = yield* repository.create({
								workspaceId: owner.workspaceId,
								agentId: owner.id,
								createdById: actor.userId,
								name: input.name,
								instructions: input.instructions,
								triggerKind: input.trigger.kind,
								cronExpression: input.trigger.kind === "cron" ? input.trigger.expression : null,
								cronTimezone: input.trigger.kind === "cron" ? input.trigger.timezone : null,
								nextScheduledAt: schedule,
								webhookSecretDigest: secret ? hashSecret(secret) : null,
								state,
							});
							return { routine: toRoutine(row), secret };
						}),
					);
				}),
			),

		update: (addressed, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						const [current] = yield* query((db) =>
							db.select().from(routine).where(inScope(scope)).limit(1),
						);
						if (!current) return yield* new RoutineNotFound();
						const trigger = input.trigger ?? toRoutine(current).trigger;
						const state = input.state ?? current.state;
						const scheduleChanged = input.trigger?.kind === "cron";
						const reenabled = input.state === "enabled" && current.state === "paused";
						const schedule =
							trigger.kind !== "cron" || state === "paused"
								? null
								: scheduleChanged || reenabled
									? yield* nextOccurrence(
											trigger.expression,
											trigger.timezone,
											yield* DateTime.nowAsDate,
										)
									: current.nextScheduledAt;
						const switchedToWebhook =
							input.trigger?.kind === "webhook" && current.triggerKind !== "webhook";
						const secret = switchedToWebhook ? generateSecret() : null;
						const row = yield* repository.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							triggerKind: trigger.kind,
							cronExpression: trigger.kind === "cron" ? trigger.expression : null,
							cronTimezone: trigger.kind === "cron" ? trigger.timezone : null,
							nextScheduledAt: schedule,
							webhookSecretDigest:
								trigger.kind !== "webhook"
									? null
									: secret
										? hashSecret(secret)
										: current.webhookSecretDigest,
						});
						if (!row) return yield* new RoutineNotFound();
						return { routine: toRoutine(row), secret };
					}),
				),
			),

		remove: (addressed) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						if (!(yield* repository.remove(scope))) return yield* new RoutineNotFound();
					}),
				),
			),

		rotateSecret: (addressed) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						const secret = generateSecret();
						yield* lockTriggers(scope.routineId);
						if (yield* repository.replaceWebhookSecret(scope, hashSecret(secret))) return secret;
						const [exists] = yield* query((db) =>
							db.select({ id: routine.id }).from(routine).where(inScope(scope)),
						);
						if (!exists) return yield* new RoutineNotFound();
						return yield* new RoutineTriggerRejected();
					}),
				),
			),

		previewSchedule: ({ agentId, expression, timezone }) =>
			operation(
				"previewSchedule",
				Effect.andThen(
					authorization.agent(agentId, "routine.manage"),
					Effect.flatMap(DateTime.nowAsDate, (now) =>
						upcomingOccurrences(expression, timezone, now),
					),
				),
			),

		run: ({ agentId, routineId, requestId }) =>
			operation(
				"run",
				Effect.gen(function* () {
					const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.run");
					return yield* acceptTrigger({
						workspaceId: owner.workspaceId,
						agentId: owner.id,
						routineId,
						triggerIdentity: requestId,
						trigger: {
							kind: "manual",
							requestId,
							requestedAt: DateTime.formatIso(yield* DateTime.now),
							requestedByUserId: actor.userId,
						},
					});
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, RoutineRepository.layer, ThreadRepository.layer]),
);

/** A routine as defined, with the webhook secret made for it, if one was. */
export interface Defined {
	routine: Routine;
	secret: string | null;
}
