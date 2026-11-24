export * as Automations from "./automations.ts";

import type {
	AcceptedRun,
	Automation,
	AutomationCurrentSecret,
	AutomationState,
	AutomationTriggerInput,
	AutomationUpdate,
	AutomationWebhookChallenge,
	GitHubTrigger,
	ListedAutomationDefinition,
	NewAutomation,
	RunPage,
	RunPageQuery,
	WebhookAuth,
	WebhookFilterTest,
} from "@sugabots/contracts";
import {
	DEFAULT_DELIVERY_ID_HEADER,
	MAX_AUTOMATION_TRIGGERS,
	webhookSecretLongEnough,
} from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { type Database, query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger, connector } from "../../database/schema.ts";
import type { RepositoryActivity } from "../../providers/connectors/github/github-events.ts";
import { Secrets } from "../../secrets/secrets.ts";
import type { InvalidCursor } from "../cursor.ts";
import { ChatStore } from "../store/store.ts";
import { lockTriggers, makeAcceptTrigger } from "./acceptance.ts";
import {
	type AutomationDeliveryIdTooLong,
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	type AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	AutomationTriggerRejected,
	automationWithTriggers,
	type InProject,
	inScope,
	type RoutineInput,
	type Scope,
	scopeOf,
	TooManyAutomationTriggers,
	TriggerSetInSettings,
	toAutomation,
	triggersOf,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { makeView } from "./automation-view.ts";
import { makeWebhooks } from "./automation-webhooks.ts";
import { makeConnectorEvents } from "./connector-events.ts";
import { type InvalidRoutineSchedule, nextOccurrence } from "./schedule.ts";
import { AutomationStore } from "./store.ts";
import { type Delivery, generateSecret } from "./webhook-auth.ts";

/**
 * The automations members define in a project, and running one when asked,
 * as the principal with the permission they have in the project. The
 * project's lead bot does each run, in a chat of its own in the
 * project. A bot's own automations are its default project's.
 *
 * Runs nobody asks for, from a routine or a webhook, are `Webhooks` and the
 * scheduler; a run is started by its workflow, one at a time per
 * automation, and ended by `AutomationSettlement`.
 */
export interface Interface {
	/**
	 * Defines an automation in a project, as made by the principal or, with
	 * `madeByBotId`, by that bot, working in the project, at the principal's
	 * request, returning the secrets made for its webhook triggers.
	 */
	readonly create: (
		project: { projectId: string; madeByBotId?: string },
		input: NewAutomation,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationStore.AutomationNameTaken
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		CurrentActor.Service
	>;
	/**
	 * Changes an automation's own settings. Pausing it stops its routines;
	 * enabling it again sets when each runs next from now.
	 */
	readonly update: (
		automation: InProject,
		input: AutomationUpdate,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationStore.AutomationNameTaken
		| InvalidRoutineSchedule,
		CurrentActor.Service
	>;
	/**
	 * Changes an automation's own settings, as `update` does, and makes the
	 * routine all that starts it, in one transaction: rewrites its one routine,
	 * or adds it when nothing starts the automation yet. Refused, changing
	 * nothing, when it has another routine or a trigger.
	 */
	readonly updateWithSoleRoutine: (
		automation: InProject,
		input: AutomationUpdate,
		routine: RoutineInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationStore.AutomationNameTaken
		| InvalidRoutineSchedule
		| TriggerSetInSettings,
		CurrentActor.Service
	>;
	/** Adds a trigger to an automation, returning a secret made for a webhook. */
	readonly addTrigger: (
		automation: InProject,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| TooManyAutomationTriggers
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		CurrentActor.Service
	>;
	/**
	 * Rewrites one of an automation's triggers, which keeps its kind. A webhook's
	 * secret is kept unless one is brought; one made for it is returned.
	 */
	readonly updateTrigger: (
		trigger: OnTrigger,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerKindChanged
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		CurrentActor.Service
	>;
	readonly removeTrigger: (
		trigger: OnTrigger,
	) => Effect.Effect<
		Automation,
		AuthorizationDenied | AutomationNotFound | AutomationTriggerNotFound,
		CurrentActor.Service
	>;
	readonly remove: (
		automation: InProject,
	) => Effect.Effect<void, AuthorizationDenied | AutomationNotFound, CurrentActor.Service>;
	/** A webhook trigger's current secret, for somebody who manages it. */
	readonly getSecret: (
		trigger: OnTrigger,
	) => Effect.Effect<
		AutomationCurrentSecret,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerRejected,
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
		| AutomationNotFound
		| AutomationTriggerNotFound
		| AutomationTriggerRejected
		| WebhookSecretTooShort,
		CurrentActor.Service
	>;
	/**
	 * Runs the automation now, for the principal: opens its chat, posts the
	 * trigger, and queues the run. Asking again with the same `requestId`
	 * returns that run again, as a duplicate.
	 */
	readonly run: (
		automation: InProject & { requestId: string },
	) => Effect.Effect<
		AcceptedRun,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationTriggerConflict
		| AutomationTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * The project's automations, by name, each with how it stands for
	 * whoever may read its runs.
	 */
	readonly list: (project: {
		projectId: string;
	}) => Effect.Effect<ListedAutomationDefinition[], AuthorizationDenied, CurrentActor.Service>;
	/**
	 * A page of the runs of every automation of the project, newest first,
	 * removed automations' included.
	 */
	readonly listProjectRuns: (
		project: { projectId: string },
		page?: RunPageQuery,
	) => Effect.Effect<RunPage, AuthorizationDenied | InvalidCursor, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Automations") {}

/**
 * Runs a webhook trigger's caller asks for. Nobody signs in to call one:
 * proving it holds the trigger's secret, the way the trigger's auth says, is
 * what admits the run, so this asks for no principal, and is the one automation
 * operation a route calls without one.
 */
export interface WebhooksInterface {
	/**
	 * Accepts a delivery's run, if it proves it holds the trigger's secret.
	 * `undefined` when it does not, or there is no such webhook trigger of an
	 * enabled automation: the caller is told the same either way. A call that
	 * does not meet the trigger's filter is `ignored`, and Slack's check that
	 * the address answers to it is answered with its challenge: neither
	 * starts a run.
	 */
	readonly accept: (input: {
		triggerId: string;
		delivery: Delivery;
	}) => Effect.Effect<
		| { kind: "run"; run: AcceptedRun }
		| { kind: "ignored" }
		| ({ kind: "challenge" } & AutomationWebhookChallenge)
		| undefined,
		AutomationTriggerConflict | AutomationTriggerRejected | AutomationDeliveryIdTooLong
	>;
}

export class Webhooks extends Context.Service<Webhooks, WebhooksInterface>()(
	"@sugabots/core/Automations/Webhooks",
) {}

/**
 * Runs connector automations for what happened at their connectors' services.
 * The service's signature on the delivery is what admits it, checked before
 * this is asked, so this asks for no principal.
 */
export interface ConnectorEventsInterface {
	/**
	 * Accepts a run of each enabled automation `activity` runs through
	 * `connectorId`, while the connector has the repository. A delivery
	 * GitHub sends again starts no new runs.
	 */
	readonly accept: (input: {
		workspaceId: string;
		connectorId: string;
		deliveryId: string;
		activity: RepositoryActivity;
	}) => Effect.Effect<AcceptedRun[]>;
}

export class ConnectorEvents extends Context.Service<ConnectorEvents, ConnectorEventsInterface>()(
	"@sugabots/core/Automations/ConnectorEvents",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Automations");
	const authorization = yield* Authorization.Service;
	const store = yield* AutomationStore.Service;
	const secrets = yield* Secrets.Service;
	const acceptTrigger = yield* makeAcceptTrigger;
	const view = yield* makeView;

	/**
	 * What a routine is written as: when it runs next while the automation
	 * runs. Worked out while it is paused too, so a timetable that cannot run is
	 * refused now rather than when the automation is enabled again.
	 */
	const routineValues = (input: RoutineInput, state: AutomationState) =>
		Effect.gen(function* () {
			const settings = {
				kind: "routine" as const,
				schedule: input.schedule,
				timezone: input.timezone,
			};
			const next = yield* nextOccurrence(
				settings.schedule,
				settings.timezone,
				yield* DateTime.nowAsDate,
			);
			const values: AutomationStore.TriggerValues = {
				...NO_SECRET,
				settings,
				nextScheduledAt: state === "enabled" ? next : null,
			};
			return { values, secret: null } satisfies Written;
		});

	/**
	 * What `input` writes for a trigger of `project`'s automation, given
	 * the trigger it rewrites, if any, and whether the automation runs: a
	 * routine's next time while it does, and a webhook's secret.
	 */
	const triggerValues = (
		project: { id: string; workspaceId: string },
		input: AutomationTriggerInput,
		current: schema.AutomationTriggerRow | undefined,
		state: AutomationState,
	): Effect.Effect<
		Written,
		| InvalidRoutineSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		Database
	> =>
		Effect.gen(function* () {
			switch (input.kind) {
				case "routine":
					return yield* routineValues(input, state);
				case "webhook": {
					const checked = yield* webhookCheck(
						secrets,
						input,
						current?.settings.kind === "webhook" ? current : undefined,
					);
					return {
						values: {
							settings: {
								kind: "webhook",
								auth: checked.auth,
								deliveryIdHeader: checked.deliveryIdHeader,
								filter: checked.filter,
							},
							secretEncrypted: checked.secretEncrypted,
							nextScheduledAt: null,
						},
						secret: checked.secret,
					};
				}
				case "github": {
					const settings = yield* inProjectsConnector(project, input);
					return { values: { ...NO_SECRET, settings, nextScheduledAt: null }, secret: null };
				}
			}
		});

	/** Stops the automation's routines while it is paused, and sets when each runs next once it is enabled. */
	const reschedule = (automationId: string, state: AutomationState) =>
		Effect.gen(function* () {
			const triggers = (yield* triggersOf([automationId])).get(automationId) ?? [];
			const now = yield* DateTime.nowAsDate;
			const next = yield* Effect.forEach(
				triggers.flatMap((trigger) =>
					trigger.settings.kind === "routine"
						? [{ id: trigger.id, settings: trigger.settings }]
						: [],
				),
				({ id, settings }) =>
					Effect.map(
						state === "enabled"
							? nextOccurrence(settings.schedule, settings.timezone, now)
							: Effect.succeed(null),
						(at) => ({ triggerId: id, at }),
					),
			);
			yield* store.scheduleNext(next);
		});

	/**
	 * Writes `input` over the automation `current`'s own settings, leaving
	 * when its routines next run as it was.
	 */
	const writeSettings = (scope: Scope, current: schema.AutomationRow, input: AutomationUpdate) =>
		Effect.gen(function* () {
			const row = yield* store.update(scope, {
				name: input.name ?? current.name,
				instructions: input.instructions ?? current.instructions,
				state: input.state ?? current.state,
				// Turned on or off by hand, it is no longer one that paused itself.
				...(input.state && { pausedAfterFailuresAt: null }),
			});
			if (!row) return yield* new AutomationNotFound();
			return row;
		});

	/**
	 * Writes `input` over the automation `current`'s own settings, which the
	 * caller holds the trigger lock of, and reschedules its routines when it
	 * is paused or enabled.
	 */
	const changeSettings = (scope: Scope, current: schema.AutomationRow, input: AutomationUpdate) =>
		Effect.gen(function* () {
			const row = yield* writeSettings(scope, current, input);
			if (row.state !== current.state) yield* reschedule(scope.automationId, row.state);
			return row;
		});

	return Service.of({
		...view,
		create: ({ projectId, madeByBotId }, input) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const { project, actor } = yield* authorization.project(projectId, "automation.manage");
						const state = input.state ?? "enabled";
						const written = yield* Effect.forEach(input.triggers, (trigger) =>
							triggerValues(project, trigger, undefined, state),
						);
						const row = yield* store.create({
							workspaceId: project.workspaceId,
							projectId: project.id,
							createdById: actor.memberId,
							createdByBotId: madeByBotId ?? null,
							name: input.name,
							instructions: input.instructions,
							state,
						});
						const scope = {
							workspaceId: project.workspaceId,
							projectId: project.id,
							automationId: row.id,
						};
						const triggers = yield* store.addTriggers(
							scope,
							written.map(({ values }) => values),
						);
						return {
							automation: toAutomation(row, triggers),
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
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						yield* lockTriggers(scope.automationId);
						const current = yield* automationIn(scope);
						const row = yield* changeSettings(scope, current, input);
						return { automation: yield* automationWithTriggers(row), secrets: [] };
					}),
				),
			),

		updateWithSoleRoutine: (addressed, input, routine) =>
			operation(
				"updateWithSoleRoutine",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						// Held across the check and both writes, so a trigger added meanwhile
						// waits, and a refused routine leaves the settings as they were.
						yield* lockTriggers(scope.automationId);
						const current = yield* automationIn(scope);
						const [only, ...others] =
							(yield* triggersOf([scope.automationId])).get(scope.automationId) ?? [];
						if (others.length > 0 || (only && only.settings.kind !== "routine")) {
							return yield* new TriggerSetInSettings();
						}
						// Written as the settings leave it, running or paused.
						const written = yield* routineValues(routine, input.state ?? current.state);
						if (only) yield* store.updateTrigger(scope, only.id, written.values);
						else yield* store.addTriggers(scope, [written.values]);
						// The sole routine was just written for the state the settings leave.
						const row = yield* writeSettings(scope, current, input);
						return { automation: yield* automationWithTriggers(row), secrets: [] };
					}),
				),
			),

		addTrigger: (addressed, input) =>
			operation(
				"addTrigger",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						yield* lockTriggers(scope.automationId);
						const current = yield* automationIn(scope);
						const existing =
							(yield* triggersOf([scope.automationId])).get(scope.automationId) ?? [];
						if (existing.length >= MAX_AUTOMATION_TRIGGERS) {
							return yield* new TooManyAutomationTriggers();
						}
						const written = yield* triggerValues(
							{ id: scope.projectId, workspaceId: scope.workspaceId },
							input,
							undefined,
							current.state,
						);
						const added = yield* store.addTriggers(scope, [written.values]);
						return {
							automation: yield* automationWithTriggers(current),
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
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						// Held until the change is written, so an edit made meanwhile, or a
						// secret replaced meanwhile, is read here rather than written over.
						yield* lockTriggers(scope.automationId);
						const current = yield* automationIn(scope);
						const trigger = yield* triggerIn(scope, addressed.triggerId);
						if (trigger.kind !== input.kind) return yield* new AutomationTriggerKindChanged();
						const written = yield* triggerValues(
							{ id: scope.projectId, workspaceId: scope.workspaceId },
							input,
							trigger,
							current.state,
						);
						const updated = yield* store.updateTrigger(scope, addressed.triggerId, written.values);
						if (!updated) return yield* new AutomationTriggerNotFound();
						return {
							automation: yield* automationWithTriggers(current),
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
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						yield* lockTriggers(scope.automationId);
						const current = yield* automationIn(scope);
						if (!(yield* store.removeTrigger(scope, addressed.triggerId))) {
							return yield* new AutomationTriggerNotFound();
						}
						return yield* automationWithTriggers(current);
					}),
				),
			),

		remove: (addressed) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						yield* lockTriggers(scope.automationId);
						if (!(yield* store.remove(scope))) return yield* new AutomationNotFound();
					}),
				),
			),

		getSecret: (addressed) =>
			operation(
				"getSecret",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "automation.manage");
					yield* automationIn(scope);
					const trigger = yield* triggerIn(scope, addressed.triggerId);
					if (trigger.settings.kind !== "webhook") return yield* new AutomationTriggerRejected();
					if (trigger.secretEncrypted === null) return { kind: "none" as const };
					return { kind: "set" as const, secret: secrets.decrypt(trigger.secretEncrypted) };
				}),
			),

		rotateSecret: (addressed, brought) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const scope = yield* scopeOf(authorization, addressed, "automation.manage");
						yield* lockTriggers(scope.automationId);
						yield* automationIn(scope);
						const trigger = yield* triggerIn(scope, addressed.triggerId);
						if (trigger.settings.kind !== "webhook") return yield* new AutomationTriggerRejected();
						const { auth } = trigger.settings;
						if (brought != null && !webhookSecretLongEnough(auth.kind, brought)) {
							return yield* new WebhookSecretTooShort();
						}
						const secret = brought === undefined ? generateSecret(auth.kind) : brought;
						const sealed = secret === null ? null : secrets.encrypt(secret);
						if (!(yield* store.replaceWebhookSecret(scope, addressed.triggerId, sealed))) {
							return yield* new AutomationTriggerNotFound();
						}
						return secret;
					}),
				),
			),

		run: ({ projectId, automationId, requestId }) =>
			operation(
				"run",
				transaction(
					Effect.gen(function* () {
						const { project, actor } = yield* authorization.project(projectId, "automation.run");
						const accepted = yield* acceptTrigger({
							workspaceId: project.workspaceId,
							projectId: project.id,
							automationId,
							triggerId: null,
							triggerIdentity: requestId,
							trigger: {
								kind: "manual",
								requestId,
								requestedAt: DateTime.formatIso(yield* DateTime.now),
								requestedByMemberId: actor.memberId,
							},
						});
						if (accepted.duplicate) return accepted;
						// Running one that paused itself after failing is trying again: it is turned back on.
						if (yield* store.resumeAfterFailures(automationId)) {
							// A routine it was saved with is one that has a next time.
							yield* Effect.orDie(reschedule(automationId, "enabled"));
						}
						return accepted;
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, AutomationStore.layer, ChatStore.layer]),
);

export const webhooksLayer = Layer.effect(Webhooks, makeWebhooks).pipe(
	Layer.provide([AutomationStore.layer, ChatStore.layer]),
);

export const connectorEventsLayer = Layer.effect(ConnectorEvents, makeConnectorEvents).pipe(
	Layer.provide([AutomationStore.layer, ChatStore.layer]),
);

/** Accepts the runs of automations' routines as they fall due. */
export { layer as schedulerLayer } from "./scheduler.ts";
/** The automation workflow's steps. */
export { automationStepsLayer as stepsLayer } from "./steps.ts";

/** An automation as defined, with the secrets made for its webhook triggers by this write. */
export interface Defined {
	automation: Automation;
	secrets: Array<{ triggerId: string; secret: string }>;
}

/** One of an automation's triggers, by the automation and its own id. */
interface OnTrigger extends InProject {
	triggerId: string;
}

/** What a trigger is written as, and the secret made for it, if this made one. */
interface Written {
	values: AutomationStore.TriggerValues;
	secret: string | null;
}

const NO_SECRET = { secretEncrypted: null } as const;

/** The secrets made for `triggers`, written in the same order as `written`. */
function secretsMade(
	triggers: readonly schema.AutomationTriggerRow[],
	written: readonly Written[],
): Defined["secrets"] {
	return triggers.flatMap((trigger, index) => {
		const secret = written[index]?.secret;
		return secret ? [{ triggerId: trigger.id, secret }] : [];
	});
}

/** The automation `scope` names, locked until the transaction ends. */
const automationIn = (scope: Scope) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			db.select().from(automation).where(inScope(scope)).limit(1).for("update"),
		);
		if (!row) return yield* new AutomationNotFound();
		return row;
	});

/** One of the automation's triggers. */
const triggerIn = (scope: Scope, triggerId: string) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			db
				.select()
				.from(automationTrigger)
				.where(
					and(
						eq(automationTrigger.id, triggerId),
						eq(automationTrigger.automationId, scope.automationId),
					),
				)
				.limit(1),
		);
		if (!row) return yield* new AutomationTriggerNotFound();
		return row;
	});

/**
 * `trigger`'s settings, once its connector is one of the project's and
 * the repository one of the connector's, written as the connector has it,
 * since GitHub's names ignore case.
 */
const inProjectsConnector = (
	project: { id: string; workspaceId: string },
	trigger: GitHubTrigger,
): Effect.Effect<
	Extract<schema.AutomationTriggerSettings, { kind: "github" }>,
	AutomationRepositoryNotConnected,
	Database
> =>
	Effect.gen(function* () {
		const [connected] = yield* query((db) =>
			db
				.select({ settings: connector.settings })
				.from(connector)
				.where(
					and(
						eq(connector.projectId, project.id),
						eq(connector.workspaceId, project.workspaceId),
						eq(connector.id, trigger.connectorId),
					),
				)
				.limit(1),
		);
		const found = connected?.settings?.repositories.find(
			(one) => one.path.toLowerCase() === trigger.repository.toLowerCase(),
		);
		if (!found) return yield* new AutomationRepositoryNotConnected();
		return {
			kind: "github",
			connectorId: trigger.connectorId,
			repository: found.path,
			events: [...new Set(trigger.events)],
		};
	});

/** What a new webhook trigger checks its callers with until somebody chooses. */
const DEFAULT_WEBHOOK_AUTH: WebhookAuth = { kind: "bearer" };

/**
 * How a webhook trigger written as `input` checks its callers, and which of
 * their calls it runs, given how it did before (`current`, absent for a new
 * one). The filter is kept unless one is brought, and none is `undefined`.
 * The secret, or the lack of one, is kept whatever the auth becomes, unless
 * one is brought; a null one leaves it without. A new webhook without one
 * brought gets one made, which is returned. A secret
 * brought for a generic webhook must be long enough to be hard to guess; a
 * source's is whatever the source made.
 */
function webhookCheck(
	secrets: Secrets.Interface,
	input: Extract<AutomationTriggerInput, { kind: "webhook" }>,
	current: schema.AutomationTriggerRow | undefined,
): Effect.Effect<
	{
		auth: WebhookAuth;
		deliveryIdHeader: string | null;
		filter: readonly WebhookFilterTest[] | undefined;
		secretEncrypted: string | null;
		secret: string | null;
	},
	WebhookSecretTooShort | WebhookDeliveryIdHeaderRejected
> {
	const currentSettings = current?.settings.kind === "webhook" ? current.settings : undefined;
	const auth = input.auth ?? currentSettings?.auth ?? DEFAULT_WEBHOOK_AUTH;
	const deliveryIdHeader =
		input.deliveryIdHeader !== undefined
			? input.deliveryIdHeader
			: currentSettings
				? currentSettings.deliveryIdHeader
				: DEFAULT_DELIVERY_ID_HEADER;
	const deliveryHeader = deliveryIdHeader?.toLowerCase();
	if (
		deliveryHeader === "authorization" ||
		(auth.kind === "api_key" && deliveryHeader === auth.header.toLowerCase())
	) {
		return Effect.fail(new WebhookDeliveryIdHeaderRejected());
	}
	const brought = input.filter ?? currentSettings?.filter;
	const filter = brought?.length ? brought : undefined;
	if (typeof input.secret === "string" && !webhookSecretLongEnough(auth.kind, input.secret)) {
		return Effect.fail(new WebhookSecretTooShort());
	}
	if (current && input.secret === undefined) {
		return Effect.succeed({
			auth,
			deliveryIdHeader,
			filter,
			secretEncrypted: current.secretEncrypted,
			secret: null,
		});
	}
	if (input.secret === null) {
		return Effect.succeed({
			auth,
			deliveryIdHeader,
			filter,
			secretEncrypted: null,
			secret: null,
		});
	}
	const secret = input.secret ?? generateSecret(auth.kind);
	return Effect.succeed({
		auth,
		deliveryIdHeader,
		filter,
		secretEncrypted: secrets.encrypt(secret),
		secret,
	});
}
