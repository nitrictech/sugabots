export * as Routines from "./routines.ts";

import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineCurrentSecret,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	RoutineSchedule,
	RoutineState,
	RoutineTriggerInput,
	RoutineUpdate,
	RoutineWebhookChallenge,
	WebhookAuth,
	WorkspaceRoutine,
} from "@sugabots/contracts";
import { MAX_ROUTINE_TRIGGERS, webhookSecretLongEnough } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { routine, routineTrigger } from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	type OnAgent,
	type RoutineDeliveryIdTooLong,
	RoutineNotFound,
	type RoutineTriggerConflict,
	RoutineTriggerKindChanged,
	RoutineTriggerNotFound,
	RoutineTriggerRejected,
	routineWithTriggers,
	type Scope,
	scopeOf,
	TooManyRoutineTriggers,
	toRoutine,
	triggersOf,
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
	 * `madeByAgent`, by the agent at the actor's request, returning the
	 * secrets made for its webhook triggers.
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
	 * Changes a routine's own settings. Pausing it stops its schedules;
	 * enabling it again schedules each from now.
	 */
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
	/** Adds a trigger to a routine, returning a secret made for a webhook. */
	readonly addTrigger: (
		routine: OnAgent,
		input: RoutineTriggerInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineNotFound
		| TooManyRoutineTriggers
		| InvalidRoutineSchedule
		| WebhookSecretTooShort,
		CurrentActor.Service
	>;
	/**
	 * Rewrites one of a routine's triggers, which keeps its kind. A webhook's
	 * secret is kept unless one is brought; one made for it is returned.
	 */
	readonly updateTrigger: (
		trigger: OnTrigger,
		input: RoutineTriggerInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| RoutineNotFound
		| RoutineTriggerNotFound
		| RoutineTriggerKindChanged
		| InvalidRoutineSchedule
		| WebhookSecretTooShort,
		CurrentActor.Service
	>;
	readonly removeTrigger: (
		trigger: OnTrigger,
	) => Effect.Effect<
		Routine,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerNotFound,
		CurrentActor.Service
	>;
	readonly remove: (
		routine: OnAgent,
	) => Effect.Effect<void, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/** A webhook trigger's current secret, for somebody who manages it. */
	readonly getSecret: (
		trigger: OnTrigger,
	) => Effect.Effect<
		RoutineCurrentSecret,
		AuthorizationDenied | RoutineNotFound | RoutineTriggerNotFound | RoutineTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * Replaces a webhook trigger's secret with `secret`, with a new one when
	 * it is absent, or with none when it is null, and returns it.
	 */
	readonly rotateSecret: (
		trigger: OnTrigger,
		secret?: string | null,
	) => Effect.Effect<
		string | null,
		| AuthorizationDenied
		| RoutineNotFound
		| RoutineTriggerNotFound
		| RoutineTriggerRejected
		| WebhookSecretTooShort,
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
 * Runs a webhook trigger's caller asks for. Nobody signs in to call one:
 * proving it holds the trigger's secret, the way the trigger's auth says, is
 * what admits the run, so this asks for no actor, and is the one routine
 * operation a route calls without one.
 */
export interface WebhooksInterface {
	/**
	 * Accepts a delivery's run, if it proves it holds the trigger's secret.
	 * `undefined` when it does not, or there is no such webhook trigger of an
	 * enabled routine: the caller is told the same either way. Slack's check
	 * that the address answers to it is answered with its challenge instead
	 * of a run.
	 */
	readonly accept: (input: {
		triggerId: string;
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

	/**
	 * What `input` writes for a trigger, given the trigger it rewrites, if
	 * any, and whether the routine runs: a schedule's next time while it
	 * does, and a webhook's secret.
	 */
	const triggerValues = (
		input: RoutineTriggerInput,
		current: schema.RoutineTriggerRow | undefined,
		state: RoutineState,
	): Effect.Effect<Written, InvalidRoutineSchedule | WebhookSecretTooShort> =>
		Effect.gen(function* () {
			switch (input.kind) {
				case "cron": {
					const settings = {
						kind: "cron" as const,
						schedule: input.schedule,
						timezone: input.timezone,
					};
					const next =
						state === "enabled"
							? yield* nextOccurrence(
									settings.schedule,
									settings.timezone,
									yield* DateTime.nowAsDate,
								)
							: null;
					return { values: { ...NO_SECRET, settings, nextScheduledAt: next }, secret: null };
				}
				case "webhook": {
					const checked = yield* webhookCheck(
						credentials,
						input,
						current?.settings.kind === "webhook" ? current : undefined,
					);
					return {
						values: {
							settings: { kind: "webhook", auth: checked.auth },
							secretEncrypted: checked.secretEncrypted,
							secretDigest: checked.secretDigest,
							nextScheduledAt: null,
						},
						secret: checked.secret,
					};
				}
			}
		});

	/** Stops the routine's schedules while it is paused, and schedules each from now once it is enabled. */
	const reschedule = (routineId: string, state: RoutineState) =>
		Effect.gen(function* () {
			const triggers = (yield* triggersOf([routineId])).get(routineId) ?? [];
			const now = yield* DateTime.nowAsDate;
			const next = yield* Effect.forEach(
				triggers.flatMap((trigger) =>
					trigger.settings.kind === "cron" ? [{ id: trigger.id, settings: trigger.settings }] : [],
				),
				({ id, settings }) =>
					Effect.map(
						state === "enabled"
							? nextOccurrence(settings.schedule, settings.timezone, now)
							: Effect.succeed(null),
						(at) => ({ triggerId: id, at }),
					),
			);
			yield* repository.scheduleNext(next);
		});

	return Service.of({
		...view,
		create: ({ agentId, madeByAgent = false }, input) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const { agent: owner, actor } = yield* authorization.agent(agentId, "routine.manage");
						const state = input.state ?? "enabled";
						const written = yield* Effect.forEach(input.triggers, (trigger) =>
							triggerValues(trigger, undefined, state),
						);
						const row = yield* repository.create({
							workspaceId: owner.workspaceId,
							agentId: owner.id,
							createdById: actor.userId,
							createdByAgentId: madeByAgent ? owner.id : null,
							name: input.name,
							instructions: input.instructions,
							state,
							results: input.results ?? "keep_in_run",
						});
						const scope = { workspaceId: owner.workspaceId, agentId: owner.id, routineId: row.id };
						const triggers = yield* repository.addTriggers(
							scope,
							written.map(({ values }) => values),
						);
						return {
							routine: toRoutine(row, triggers),
							secrets: secretsMade(triggers, written),
						};
					}),
				),
			),

		update: (addressed, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						const current = yield* routineIn(scope);
						const state = input.state ?? current.state;
						const row = yield* repository.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							results: input.results ?? current.results,
						});
						if (!row) return yield* new RoutineNotFound();
						if (state !== current.state) yield* reschedule(scope.routineId, state);
						return { routine: yield* routineWithTriggers(row), secrets: [] };
					}),
				),
			),

		addTrigger: (addressed, input) =>
			operation(
				"addTrigger",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						const current = yield* routineIn(scope);
						const existing = (yield* triggersOf([scope.routineId])).get(scope.routineId) ?? [];
						if (existing.length >= MAX_ROUTINE_TRIGGERS) {
							return yield* new TooManyRoutineTriggers();
						}
						const written = yield* triggerValues(input, undefined, current.state);
						const added = yield* repository.addTriggers(scope, [written.values]);
						return {
							routine: yield* routineWithTriggers(current),
							secrets: secretsMade(added, [written]),
						};
					}),
				),
			),

		updateTrigger: (addressed, input) =>
			operation(
				"updateTrigger",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						// Held until the change is written, so an edit made meanwhile, or a
						// secret replaced meanwhile, is read here rather than written over.
						yield* lockTriggers(scope.routineId);
						const current = yield* routineIn(scope);
						const trigger = yield* triggerIn(scope, addressed.triggerId);
						if (trigger.kind !== input.kind) return yield* new RoutineTriggerKindChanged();
						const written = yield* triggerValues(input, trigger, current.state);
						const updated = yield* repository.updateTrigger(
							scope,
							addressed.triggerId,
							written.values,
						);
						if (!updated) return yield* new RoutineTriggerNotFound();
						return {
							routine: yield* routineWithTriggers(current),
							secrets: secretsMade([updated], [written]),
						};
					}),
				),
			),

		removeTrigger: (addressed) =>
			operation(
				"removeTrigger",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						const current = yield* routineIn(scope);
						if (!(yield* repository.removeTrigger(scope, addressed.triggerId))) {
							return yield* new RoutineTriggerNotFound();
						}
						return yield* routineWithTriggers(current);
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
					yield* routineIn(scope);
					const trigger = yield* triggerIn(scope, addressed.triggerId);
					if (trigger.settings.kind !== "webhook") return yield* new RoutineTriggerRejected();
					if (trigger.secretEncrypted !== null) {
						return { kind: "set" as const, secret: credentials.decrypt(trigger.secretEncrypted) };
					}
					return {
						kind: trigger.secretDigest === null ? ("none" as const) : ("hashed" as const),
					};
				}),
			),

		rotateSecret: (addressed, brought) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "routine.manage");
						yield* lockTriggers(scope.routineId);
						yield* routineIn(scope);
						const trigger = yield* triggerIn(scope, addressed.triggerId);
						if (trigger.settings.kind !== "webhook") return yield* new RoutineTriggerRejected();
						const { auth } = trigger.settings;
						if (brought != null && !webhookSecretLongEnough(auth.kind, brought)) {
							return yield* new WebhookSecretTooShort();
						}
						const secret = brought === undefined ? generateSecret(auth.kind) : brought;
						const sealed = secret === null ? null : credentials.encrypt(secret);
						if (!(yield* repository.replaceWebhookSecret(scope, addressed.triggerId, sealed))) {
							return yield* new RoutineTriggerNotFound();
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
						triggerId: null,
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

/** A routine as defined, with the secrets made for its webhook triggers by this write. */
export interface Defined {
	routine: Routine;
	secrets: Array<{ triggerId: string; secret: string }>;
}

/** One of a routine's triggers, by the routine and its own id. */
export interface OnTrigger extends OnAgent {
	triggerId: string;
}

/** What a trigger is written as, and the secret made for it, if this made one. */
interface Written {
	values: RoutineRepository.TriggerValues;
	secret: string | null;
}

const NO_SECRET = { secretEncrypted: null, secretDigest: null } as const;

/** The secrets made for `triggers`, written in the same order as `written`. */
function secretsMade(
	triggers: readonly schema.RoutineTriggerRow[],
	written: readonly Written[],
): Defined["secrets"] {
	return triggers.flatMap((trigger, index) => {
		const secret = written[index]?.secret;
		return secret ? [{ triggerId: trigger.id, secret }] : [];
	});
}

/** The routine `scope` names, locked until the transaction ends. */
const routineIn = (scope: Scope) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			db.select().from(routine).where(inScope(scope)).limit(1).for("update"),
		);
		if (!row) return yield* new RoutineNotFound();
		return row;
	});

/** One of the routine's triggers. */
const triggerIn = (scope: Scope, triggerId: string) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			db
				.select()
				.from(routineTrigger)
				.where(and(eq(routineTrigger.id, triggerId), eq(routineTrigger.routineId, scope.routineId)))
				.limit(1),
		);
		if (!row) return yield* new RoutineTriggerNotFound();
		return row;
	});

/** What a new webhook trigger checks its callers with until somebody chooses. */
const DEFAULT_WEBHOOK_AUTH: WebhookAuth = { kind: "bearer" };

/**
 * How a webhook trigger written as `input` checks its callers, given how it
 * did before (`current`, absent for a new one). The secret, or the lack of
 * one, is kept whatever the auth becomes, unless one is brought; a null one
 * leaves it without. A new webhook without one brought gets one made, which
 * is returned, and so does one leaving bearer auth with only the hash of a
 * token made before secrets were kept. A secret brought for a generic
 * webhook must be long enough to be hard to guess; a source's is whatever its
 * sender made.
 */
function webhookCheck(
	credentials: Credentials.Interface,
	input: Extract<RoutineTriggerInput, { kind: "webhook" }>,
	current: schema.RoutineTriggerRow | undefined,
): Effect.Effect<
	{
		auth: WebhookAuth;
		secretEncrypted: string | null;
		secretDigest: string | null;
		secret: string | null;
	},
	WebhookSecretTooShort
> {
	const currentAuth = current?.settings.kind === "webhook" ? current.settings.auth : undefined;
	const auth = input.auth ?? currentAuth ?? DEFAULT_WEBHOOK_AUTH;
	if (typeof input.secret === "string" && !webhookSecretLongEnough(auth.kind, input.secret)) {
		return Effect.fail(new WebhookSecretTooShort());
	}
	const hashOnly = current?.secretDigest != null && auth.kind !== "bearer";
	if (current && !hashOnly && input.secret === undefined) {
		return Effect.succeed({
			auth,
			secretEncrypted: current.secretEncrypted,
			secretDigest: current.secretDigest,
			secret: null,
		});
	}
	if (input.secret === null) {
		return Effect.succeed({ auth, secretEncrypted: null, secretDigest: null, secret: null });
	}
	const secret = input.secret ?? generateSecret(auth.kind);
	return Effect.succeed({
		auth,
		secretEncrypted: credentials.encrypt(secret),
		secretDigest: null,
		secret,
	});
}
