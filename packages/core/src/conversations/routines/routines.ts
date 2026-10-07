export * as Routines from "./routines.ts";

import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineCurrentSecret,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	RoutineSchedule,
	RoutineUpdate,
	RoutineWebhookChallenge,
	WebhookAuth,
	WorkspaceRoutine,
} from "@sugabots/contracts";
import { webhookSecretLongEnough } from "@sugabots/contracts";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { routine } from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	type OnAgent,
	type RoutineDeliveryIdTooLong,
	RoutineNotFound,
	type RoutineTriggerConflict,
	RoutineTriggerRejected,
	scopeOf,
	toRoutine,
	WebhookSecretTooShort,
} from "./routine.ts";
import { type InvalidRoutineExecutionCursor, makeView } from "./routine-view.ts";
import { makeWebhooks } from "./routine-webhooks.ts";
import { type InvalidRoutineSchedule, nextOccurrence, upcomingOccurrences } from "./schedule.ts";
import { type Delivery, generateSecret } from "./webhook-auth.ts";

/**
 * The routines people define on a crew agent, and running one when asked,
 * as the current actor with the permission its agent's pod gives them. Each
 * run is in its own thread in the agent's chat.
 *
 * Runs nobody asks for, on a webhook or a schedule, are `Webhooks` and the
 * scheduler; a run is started by its workflow, one at a time per
 * routine, and ended by `RoutineSettlement`.
 */
export interface Interface {
	/**
	 * Defines a routine on a crew agent, as made by the actor or, with
	 * `madeByAgent`, by the agent at the actor's request, returning a webhook
	 * routine's secret.
	 */
	readonly create: (
		owner: { agentId: string; madeByAgent?: boolean },
		input: NewRoutine,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineRepository.RoutineNameTaken
		| InvalidRoutineSchedule
		| WebhookSecretTooShort,
		CurrentActor.Service
	>;
	/**
	 * Changes a routine. A webhook routine's secret is kept unless one is
	 * brought; one made for it is returned.
	 */
	readonly update: (
		routine: OnAgent,
		input: RoutineUpdate,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineNotFound
		| RoutineRepository.RoutineNameTaken
		| InvalidRoutineSchedule
		| WebhookSecretTooShort,
		CurrentActor.Service
	>;
	readonly remove: (
		routine: OnAgent,
	) => Effect.Effect<void, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/** A webhook routine's current secret, for somebody who manages it. */
	readonly getSecret: (
		routine: OnAgent,
	) => Effect.Effect<
		RoutineCurrentSecret,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * Replaces a webhook routine's secret with `secret`, with a new one when
	 * it is absent, or with none when it is null, and returns it.
	 */
	readonly rotateSecret: (
		routine: OnAgent,
		secret?: string | null,
	) => Effect.Effect<
		string | null,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerRejected | WebhookSecretTooShort,
		CurrentActor.Service
	>;
	/**
	 * When a schedule would run next, for somebody choosing one for the
	 * agent's routines.
	 */
	readonly previewSchedule: (input: {
		agentId: string;
		schedule: RoutineSchedule;
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
	/**
	 * Every routine on a crew agent in a pod the actor reaches, in a workspace
	 * named by its id or its slug, by name, with its agent and pod.
	 */
	readonly listInWorkspace: (
		workspace: string,
	) => Effect.Effect<WorkspaceRoutine[], AuthorizationDenied, CurrentActor.Service>;
	/** The agent's routines, by name. */
	readonly list: (owner: {
		agentId: string;
	}) => Effect.Effect<Routine[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		routine: OnAgent,
	) => Effect.Effect<Routine, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/**
	 * A page of the routine's runs, newest first. A removed routine keeps its
	 * history, so this finds it as long as it was ever defined.
	 */
	readonly listExecutions: (
		routine: OnAgent,
		page?: RoutineExecutionPageQuery,
	) => Effect.Effect<
		RoutineExecutionPage,
		AuthorizationDenied | RoutineNotFound | InvalidRoutineExecutionCursor,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Routines") {}

/**
 * Runs a webhook routine's caller asks for. Nobody signs in to call one:
 * proving it holds the routine's secret, the way the routine's auth says, is
 * what admits the run, so this asks for no actor, and is the one routine
 * operation a route calls without one.
 */
export interface WebhooksInterface {
	/**
	 * Accepts a delivery's run, if it proves it holds the routine's secret.
	 * `undefined` when it does not, or there is no such enabled webhook
	 * routine: the caller is told the same either way. Slack's check that the
	 * address answers to it is answered with its challenge instead of a run.
	 */
	readonly accept: (input: {
		routineId: string;
		delivery: Delivery;
	}) => Effect.Effect<
		| { kind: "run"; execution: AcceptedRoutineExecution }
		| ({ kind: "challenge" } & RoutineWebhookChallenge)
		| undefined,
		RoutineTriggerConflict | RoutineTriggerRejected | RoutineDeliveryIdTooLong
	>;
}

export class Webhooks extends Context.Service<Webhooks, WebhooksInterface>()(
	"@sugabots/core/Routines/Webhooks",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Routines");
	const authorization = yield* Authorization.Service;
	const repository = yield* RoutineRepository.Service;
	const credentials = yield* Credentials.Service;
	const acceptTrigger = yield* makeAcceptTrigger;
	const view = yield* makeView;

	return Service.of({
		...view,
		create: ({ agentId, madeByAgent = false }, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.manage");
					const state = input.state ?? "enabled";
					const schedule =
						input.trigger.kind === "cron" && state === "enabled"
							? yield* nextOccurrence(
									input.trigger.schedule,
									input.trigger.timezone,
									yield* DateTime.nowAsDate,
								)
							: null;
					const webhook =
						input.trigger.kind === "webhook"
							? yield* webhookCheck(credentials, input.trigger, undefined)
							: NO_WEBHOOK;
					const row = yield* repository.create({
						workspaceId: owner.workspaceId,
						agentId: owner.id,
						createdById: actor.userId,
						createdByAgentId: madeByAgent ? owner.id : null,
						name: input.name,
						instructions: input.instructions,
						triggerKind: input.trigger.kind,
						...scheduleColumns(input.trigger.kind === "cron" ? input.trigger : undefined),
						nextScheduledAt: schedule,
						...webhook.columns,
						state,
						results: input.results ?? "keep_in_run",
					});
					return { routine: toRoutine(row), secret: webhook.secret };
				}),
			),

		update: (addressed, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						// Held until the change is written, so an edit made meanwhile, or a
						// secret replaced meanwhile, is read here rather than written over.
						yield* lockTriggers(scope.routineId);
						const [current] = yield* query((db) =>
							db.select().from(routine).where(inScope(scope)).limit(1).for("update"),
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
											trigger.schedule,
											trigger.timezone,
											yield* DateTime.nowAsDate,
										)
									: current.nextScheduledAt;
						const webhook =
							input.trigger?.kind === "webhook"
								? yield* webhookCheck(
										credentials,
										input.trigger,
										current.triggerKind === "webhook" ? current : undefined,
									)
								: trigger.kind === "webhook"
									? { columns: webhookColumnsOf(current), secret: null }
									: NO_WEBHOOK;
						const row = yield* repository.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							results: input.results ?? current.results,
							triggerKind: trigger.kind,
							...scheduleColumns(trigger.kind === "cron" ? trigger : undefined),
							nextScheduledAt: schedule,
							...webhook.columns,
						});
						if (!row) return yield* new RoutineNotFound();
						return { routine: toRoutine(row), secret: webhook.secret };
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

		getSecret: (addressed) =>
			operation(
				"getSecret",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "routine.manage");
					const [current] = yield* query((db) =>
						db
							.select({
								auth: routine.webhookAuth,
								secret: routine.webhookSecret,
								digest: routine.webhookSecretDigest,
							})
							.from(routine)
							.where(inScope(scope))
							.limit(1),
					);
					if (!current) return yield* new RoutineNotFound();
					if (!current.auth) return yield* new RoutineTriggerRejected();
					if (current.secret !== null) {
						return { kind: "set" as const, secret: credentials.decrypt(current.secret) };
					}
					return { kind: current.digest === null ? ("none" as const) : ("hashed" as const) };
				}),
			),

		rotateSecret: (addressed, brought) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						const [current] = yield* query((db) =>
							db.select({ auth: routine.webhookAuth }).from(routine).where(inScope(scope)).limit(1),
						);
						if (!current) return yield* new RoutineNotFound();
						if (!current.auth) return yield* new RoutineTriggerRejected();
						if (brought != null && !webhookSecretLongEnough(current.auth.kind, brought)) {
							return yield* new WebhookSecretTooShort();
						}
						const secret = brought === undefined ? generateSecret(current.auth.kind) : brought;
						const sealed = secret === null ? null : credentials.encrypt(secret);
						if (!(yield* repository.replaceWebhookSecret(scope, sealed))) {
							return yield* new RoutineNotFound();
						}
						return secret;
					}),
				),
			),

		previewSchedule: ({ agentId, schedule, timezone }) =>
			operation(
				"previewSchedule",
				Effect.andThen(
					authorization.agent(agentId, "routine.manage"),
					Effect.flatMap(DateTime.nowAsDate, (now) => upcomingOccurrences(schedule, timezone, now)),
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
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		RoutineRepository.layer,
		ThreadRepository.layer,
	]),
);

export const webhooksLayer = Layer.effect(Webhooks, makeWebhooks).pipe(
	Layer.provide([RoutineRepository.layer, ThreadRepository.layer]),
);

export { routineExecutionIdOf, toRoutineExecution } from "./execution.ts";
export { InvalidRoutineExecutionCursor } from "./routine-view.ts";
/** Accepts the runs of cron routines as they fall due. */
export { layer as schedulerLayer } from "./scheduler.ts";
/** The routine workflow's steps. */
export { routineStepsLayer as stepsLayer } from "./steps.ts";

/** A routine as defined, with its webhook secret if this made or replaced it. */
export interface Defined {
	routine: Routine;
	secret: string | null;
}

/**
 * Where a scheduled routine's schedule is kept: a written cron expression as
 * it was, a picked one as its parts. A routine with no schedule has neither.
 */
function scheduleColumns(
	scheduled: { schedule: RoutineSchedule; timezone: string } | undefined,
): Pick<schema.RoutineRow, "cronExpression" | "schedule" | "cronTimezone"> {
	if (!scheduled) return { cronExpression: null, schedule: null, cronTimezone: null };
	const { schedule, timezone } = scheduled;
	return schedule.repeat === "cron"
		? { cronExpression: schedule.expression, schedule: null, cronTimezone: timezone }
		: { cronExpression: null, schedule, cronTimezone: timezone };
}

/** How a routine that is not a webhook checks its callers: it has none. */
const NO_WEBHOOK = {
	columns: { webhookAuth: null, webhookSecret: null, webhookSecretDigest: null },
	secret: null,
} as const;

/** What a new webhook routine checks its callers with until somebody chooses. */
const DEFAULT_WEBHOOK_AUTH: WebhookAuth = { kind: "bearer" };

type WebhookColumns = Pick<
	schema.RoutineRow,
	"webhookAuth" | "webhookSecret" | "webhookSecretDigest"
>;

function webhookColumnsOf(row: WebhookColumns): WebhookColumns {
	return {
		webhookAuth: row.webhookAuth,
		webhookSecret: row.webhookSecret,
		webhookSecretDigest: row.webhookSecretDigest,
	};
}

/**
 * How a routine whose trigger is written as `trigger` checks its callers,
 * given how it did before (`current`, absent when it was not a webhook). The
 * secret, or the lack of one, is kept whatever the auth becomes, unless one
 * is brought; a null one leaves the routine without. A new webhook without
 * one brought gets one made, which is returned, and so does one leaving
 * bearer auth with only the hash of a token made before secrets were kept.
 * A secret brought for a generic webhook must be long enough to be hard to
 * guess; a source's is whatever its sender made.
 */
function webhookCheck(
	credentials: Credentials.Interface,
	trigger: Extract<NewRoutine["trigger"], { kind: "webhook" }>,
	current: WebhookColumns | undefined,
): Effect.Effect<{ columns: WebhookColumns; secret: string | null }, WebhookSecretTooShort> {
	const auth = trigger.auth ?? current?.webhookAuth ?? DEFAULT_WEBHOOK_AUTH;
	if (typeof trigger.secret === "string" && !webhookSecretLongEnough(auth.kind, trigger.secret)) {
		return Effect.fail(new WebhookSecretTooShort());
	}
	const hashOnly = current?.webhookSecretDigest != null && auth.kind !== "bearer";
	if (current?.webhookAuth && !hashOnly && trigger.secret === undefined) {
		return Effect.succeed({
			columns: { ...webhookColumnsOf(current), webhookAuth: auth },
			secret: null,
		});
	}
	if (trigger.secret === null) {
		return Effect.succeed({
			columns: { webhookAuth: auth, webhookSecret: null, webhookSecretDigest: null },
			secret: null,
		});
	}
	const secret = trigger.secret ?? generateSecret(auth.kind);
	return Effect.succeed({
		columns: {
			webhookAuth: auth,
			webhookSecret: credentials.encrypt(secret),
			webhookSecretDigest: null,
		},
		secret,
	});
}
