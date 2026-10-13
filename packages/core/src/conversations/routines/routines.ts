export * as Routines from "./routines.ts";

import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	RoutineUpdate,
	RoutineWebhookChallenge,
	WebhookAuth,
	WorkspaceRoutine,
} from "@sugabots/contracts";
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
	/** Defines a routine on a crew agent, returning a webhook routine's secret. */
	readonly create: (
		owner: { agentId: string },
		input: NewRoutine,
	) => Effect.Effect<
		Defined,
		AuthorizationDenied | RoutineRepository.RoutineNameTaken | InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	/**
	 * Changes a routine. A webhook routine's secret is kept unless one is
	 * brought or its auth kind changes; a new one is returned.
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
	readonly remove: (
		routine: OnAgent,
	) => Effect.Effect<void, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/**
	 * Replaces a webhook routine's secret with `secret`, or with a new one
	 * when it is absent, and returns it.
	 */
	readonly rotateSecret: (
		routine: OnAgent,
		secret?: string,
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
					const webhook =
						input.trigger.kind === "webhook"
							? webhookCheck(credentials, input.trigger, undefined)
							: NO_WEBHOOK;
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
											trigger.expression,
											trigger.timezone,
											yield* DateTime.nowAsDate,
										)
									: current.nextScheduledAt;
						const webhook =
							input.trigger?.kind === "webhook"
								? webhookCheck(
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
							cronExpression: trigger.kind === "cron" ? trigger.expression : null,
							cronTimezone: trigger.kind === "cron" ? trigger.timezone : null,
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
						const secret = brought ?? generateSecret(current.auth.kind);
						const sealed = credentials.encrypt(secret);
						if (!(yield* repository.replaceWebhookSecret(scope, sealed))) {
							return yield* new RoutineNotFound();
						}
						return secret;
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
 * secret is kept unless one is brought or the auth kind changes, since each
 * kind's secrets look different; then the new one is returned.
 */
function webhookCheck(
	credentials: Credentials.Interface,
	trigger: Extract<NewRoutine["trigger"], { kind: "webhook" }>,
	current: WebhookColumns | undefined,
): { columns: WebhookColumns; secret: string | null } {
	const auth = trigger.auth ?? current?.webhookAuth ?? DEFAULT_WEBHOOK_AUTH;
	if (current && current.webhookAuth?.kind === auth.kind && trigger.secret === undefined) {
		return { columns: { ...webhookColumnsOf(current), webhookAuth: auth }, secret: null };
	}
	const secret = trigger.secret ?? generateSecret(auth.kind);
	return {
		columns: {
			webhookAuth: auth,
			webhookSecret: credentials.encrypt(secret),
			webhookSecretDigest: null,
		},
		secret,
	};
}
