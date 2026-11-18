export * as Automations from "./automations.ts";

import type {
	AcceptedRun,
	Automation,
	AutomationCurrentSecret,
	AutomationSchedule,
	AutomationState,
	AutomationTriggerInput,
	AutomationUpdate,
	AutomationWebhookChallenge,
	GitHubTrigger,
	NewAutomation,
	RunPage,
	RunPageQuery,
	WebhookAuth,
	WebhookCondition,
	WorkspaceAutomation,
} from "@sugabots/contracts";
import { MAX_AUTOMATION_TRIGGERS, webhookSecretLongEnough } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { Credentials } from "../../credentials/credentials.ts";
import { type Database, query, serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger, bot, connection } from "../../database/schema.ts";
import type { RepositoryActivity } from "../../providers/connections/github/github-events.ts";
import { ConversationRepository } from "../repository/repository.ts";
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
	inScope,
	type OnBot,
	type Scope,
	scopeOf,
	TooManyAutomationTriggers,
	toAutomation,
	triggersOf,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { type InvalidRunCursor, makeView } from "./automation-view.ts";
import { makeWebhooks } from "./automation-webhooks.ts";
import { makeConnectionEvents } from "./connection-events.ts";
import { AutomationRepository } from "./repository.ts";
import { type InvalidAutomationSchedule, nextOccurrence, upcomingOccurrences } from "./schedule.ts";
import { type Delivery, generateSecret } from "./webhook-auth.ts";

/**
 * The automations people define on a bot, and running one when asked,
 * as the current actor with the permission they have on its bot. Each
 * run is in its own conversation in the bot's chat.
 *
 * Runs nobody asks for, on a webhook or a schedule, are `Webhooks` and the
 * scheduler; a run is started by its workflow, one at a time per
 * automation, and ended by `AutomationSettlement`.
 */
export interface Interface {
	/**
	 * Defines an automation on a bot, as made by the actor or, with
	 * `madeByBot`, by the bot at the actor's request, returning the
	 * secrets made for its webhook triggers.
	 */
	readonly create: (
		owner: { botId: string; madeByBot?: boolean },
		input: NewAutomation,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationRepository.AutomationNameTaken
		| InvalidAutomationSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		CurrentActor.Service
	>;
	/**
	 * Changes an automation's own settings. Pausing it stops its schedules;
	 * enabling it again schedules each from now.
	 */
	readonly update: (
		automation: OnBot,
		input: AutomationUpdate,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationRepository.AutomationNameTaken
		| InvalidAutomationSchedule,
		CurrentActor.Service
	>;
	/** Adds a trigger to an automation, returning a secret made for a webhook. */
	readonly addTrigger: (
		automation: OnBot,
		input: AutomationTriggerInput,
	) => Effect.Effect<
		Defined,
		| AuthorizationDenied
		| AutomationNotFound
		| TooManyAutomationTriggers
		| InvalidAutomationSchedule
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
		| InvalidAutomationSchedule
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
		automation: OnBot,
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
	 * When a schedule would run next, for somebody choosing one for the
	 * bot's automations.
	 */
	readonly previewSchedule: (input: {
		botId: string;
		schedule: AutomationSchedule;
		timezone: string;
	}) => Effect.Effect<
		Date[],
		AuthorizationDenied | InvalidAutomationSchedule,
		CurrentActor.Service
	>;
	/**
	 * Runs the automation now, for the actor: opens its conversation, posts the
	 * trigger, and queues the run. Asking again with the same `requestId`
	 * returns that run again, as a duplicate.
	 */
	readonly run: (
		automation: OnBot & { requestId: string },
	) => Effect.Effect<
		AcceptedRun,
		| AuthorizationDenied
		| AutomationNotFound
		| AutomationTriggerConflict
		| AutomationTriggerRejected,
		CurrentActor.Service
	>;
	/**
	 * Every automation on a bot the actor reaches, in a workspace
	 * named by its id or its slug, by name, with its bot and channel.
	 */
	readonly listInWorkspace: (
		workspace: string,
	) => Effect.Effect<WorkspaceAutomation[], AuthorizationDenied, CurrentActor.Service>;
	/** The bot's automations, by name. */
	readonly list: (owner: {
		botId: string;
	}) => Effect.Effect<Automation[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		automation: OnBot,
	) => Effect.Effect<Automation, AuthorizationDenied | AutomationNotFound, CurrentActor.Service>;
	/**
	 * A page of the automation's runs, newest first. A removed automation keeps its
	 * history, so this finds it as long as it was ever defined.
	 */
	readonly listRuns: (
		automation: OnBot,
		page?: RunPageQuery,
	) => Effect.Effect<
		RunPage,
		AuthorizationDenied | AutomationNotFound | InvalidRunCursor,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Automations") {}

/**
 * Runs a webhook trigger's caller asks for. Nobody signs in to call one:
 * proving it holds the trigger's secret, the way the trigger's auth says, is
 * what admits the run, so this asks for no actor, and is the one automation
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
 * Runs connection automations for what happened at their connections' services.
 * The service's signature on the delivery is what admits it, checked before
 * this is asked, so this asks for no actor.
 */
export interface ConnectionEventsInterface {
	/**
	 * Accepts a run of each enabled automation `activity` runs through
	 * `connectionId`, while the connection has the repository. A delivery
	 * GitHub sends again starts no new runs.
	 */
	readonly accept: (input: {
		workspaceId: string;
		connectionId: string;
		deliveryId: string;
		activity: RepositoryActivity;
	}) => Effect.Effect<AcceptedRun[]>;
}

export class ConnectionEvents extends Context.Service<
	ConnectionEvents,
	ConnectionEventsInterface
>()("@sugabots/core/Automations/ConnectionEvents") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Automations");
	const authorization = yield* Authorization.Service;
	const repository = yield* AutomationRepository.Service;
	const credentials = yield* Credentials.Service;
	const acceptTrigger = yield* makeAcceptTrigger;
	const view = yield* makeView;

	/**
	 * What `input` writes for a trigger of the bot `owner`'s automation, given
	 * the trigger it rewrites, if any, and whether the automation runs: a
	 * schedule's next time while it does, and a webhook's secret.
	 */
	const triggerValues = (
		owner: { id: string; workspaceId: string },
		input: AutomationTriggerInput,
		current: schema.AutomationTriggerRow | undefined,
		state: AutomationState,
	): Effect.Effect<
		Written,
		| InvalidAutomationSchedule
		| WebhookSecretTooShort
		| WebhookDeliveryIdHeaderRejected
		| AutomationRepositoryNotConnected,
		Database
	> =>
		Effect.gen(function* () {
			switch (input.kind) {
				case "schedule": {
					const settings = {
						kind: "schedule" as const,
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
							settings: {
								kind: "webhook",
								auth: checked.auth,
								deliveryIdHeader: checked.deliveryIdHeader,
								filter: checked.filter,
							},
							secretEncrypted: checked.secretEncrypted,
							secretDigest: checked.secretDigest,
							nextScheduledAt: null,
						},
						secret: checked.secret,
					};
				}
				case "github": {
					const settings = yield* inChannelsConnection(owner, input);
					return { values: { ...NO_SECRET, settings, nextScheduledAt: null }, secret: null };
				}
			}
		});

	/** Stops the automation's schedules while it is paused, and schedules each from now once it is enabled. */
	const reschedule = (automationId: string, state: AutomationState) =>
		Effect.gen(function* () {
			const triggers = (yield* triggersOf([automationId])).get(automationId) ?? [];
			const now = yield* DateTime.nowAsDate;
			const next = yield* Effect.forEach(
				triggers.flatMap((trigger) =>
					trigger.settings.kind === "schedule"
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
			yield* repository.scheduleNext(next);
		});

	return Service.of({
		...view,
		create: ({ botId, madeByBot = false }, input) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const { bot: owner, actor } = yield* authorization.bot(botId, "automation.manage");
						const state = input.state ?? "enabled";
						const written = yield* Effect.forEach(input.triggers, (trigger) =>
							triggerValues(owner, trigger, undefined, state),
						);
						const row = yield* repository.create({
							workspaceId: owner.workspaceId,
							botId: owner.id,
							createdById: actor.userId,
							createdByBotId: madeByBot ? owner.id : null,
							name: input.name,
							instructions: input.instructions,
							state,
						});
						const scope = {
							workspaceId: owner.workspaceId,
							botId: owner.id,
							automationId: row.id,
						};
						const triggers = yield* repository.addTriggers(
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
						const state = input.state ?? current.state;
						const row = yield* repository.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							// Turned on or off by hand, it is no longer one that paused itself.
							...(input.state && { pausedAfterFailuresAt: null }),
						});
						if (!row) return yield* new AutomationNotFound();
						if (state !== current.state) yield* reschedule(scope.automationId, state);
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
							{ id: scope.botId, workspaceId: scope.workspaceId },
							input,
							undefined,
							current.state,
						);
						const added = yield* repository.addTriggers(scope, [written.values]);
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
							{ id: scope.botId, workspaceId: scope.workspaceId },
							input,
							trigger,
							current.state,
						);
						const updated = yield* repository.updateTrigger(
							scope,
							addressed.triggerId,
							written.values,
						);
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
						if (!(yield* repository.removeTrigger(scope, addressed.triggerId))) {
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
						if (!(yield* repository.remove(scope))) return yield* new AutomationNotFound();
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
						const sealed = secret === null ? null : credentials.encrypt(secret);
						if (!(yield* repository.replaceWebhookSecret(scope, addressed.triggerId, sealed))) {
							return yield* new AutomationTriggerNotFound();
						}
						return secret;
					}),
				),
			),

		previewSchedule: ({ botId, schedule, timezone }) =>
			operation(
				"previewSchedule",
				Effect.andThen(
					authorization.bot(botId, "automation.manage"),
					Effect.flatMap(DateTime.nowAsDate, (now) => upcomingOccurrences(schedule, timezone, now)),
				),
			),

		run: ({ botId, automationId, requestId }) =>
			operation(
				"run",
				transaction(
					Effect.gen(function* () {
						const { bot: owner, actor } = yield* authorization.bot(botId, "automation.run");
						const accepted = yield* acceptTrigger({
							workspaceId: owner.workspaceId,
							botId: owner.id,
							automationId,
							triggerId: null,
							triggerIdentity: requestId,
							trigger: {
								kind: "manual",
								requestId,
								requestedAt: DateTime.formatIso(yield* DateTime.now),
								requestedByUserId: actor.userId,
							},
						});
						if (accepted.duplicate) return accepted;
						// Running one that paused itself after failing is trying again: it is turned back on.
						if (yield* repository.resumeAfterFailures(automationId)) {
							// A schedule it was saved with is one that has a next time.
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
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		AutomationRepository.layer,
		ConversationRepository.layer,
	]),
);

export const webhooksLayer = Layer.effect(Webhooks, makeWebhooks).pipe(
	Layer.provide([AutomationRepository.layer, ConversationRepository.layer]),
);

export const connectionEventsLayer = Layer.effect(ConnectionEvents, makeConnectionEvents).pipe(
	Layer.provide([AutomationRepository.layer, ConversationRepository.layer]),
);

export { InvalidRunCursor } from "./automation-view.ts";
/** Accepts the runs of scheduled automations as they fall due. */
export { layer as schedulerLayer } from "./scheduler.ts";
/** The automation workflow's steps. */
export { automationStepsLayer as stepsLayer } from "./steps.ts";

/** An automation as defined, with the secrets made for its webhook triggers by this write. */
export interface Defined {
	automation: Automation;
	secrets: Array<{ triggerId: string; secret: string }>;
}

/** One of an automation's triggers, by the automation and its own id. */
interface OnTrigger extends OnBot {
	triggerId: string;
}

/** What a trigger is written as, and the secret made for it, if this made one. */
interface Written {
	values: AutomationRepository.TriggerValues;
	secret: string | null;
}

const NO_SECRET = { secretEncrypted: null, secretDigest: null } as const;

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
 * `trigger`'s settings, once its connection is one of the bot's and
 * the repository one of the connection's, written as the connection has it,
 * since GitHub's names ignore case.
 */
const inChannelsConnection = (
	owner: { id: string; workspaceId: string },
	trigger: GitHubTrigger,
): Effect.Effect<
	Extract<schema.AutomationTriggerSettings, { kind: "github" }>,
	AutomationRepositoryNotConnected,
	Database
> =>
	Effect.gen(function* () {
		const [connected] = yield* query((db) =>
			db
				.select({ settings: connection.settings })
				.from(connection)
				.innerJoin(
					bot,
					and(eq(bot.id, connection.botId), eq(bot.workspaceId, connection.workspaceId)),
				)
				.where(
					and(
						eq(bot.id, owner.id),
						eq(bot.workspaceId, owner.workspaceId),
						eq(connection.id, trigger.connectionId),
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
			connectionId: trigger.connectionId,
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
 * brought gets one made, which is returned, and so does one leaving bearer
 * auth with only the hash of a token made before secrets were kept. A secret
 * brought for a generic webhook must be long enough to be hard to guess; a
 * source's is whatever its sender made.
 */
function webhookCheck(
	credentials: Credentials.Interface,
	input: Extract<AutomationTriggerInput, { kind: "webhook" }>,
	current: schema.AutomationTriggerRow | undefined,
): Effect.Effect<
	{
		auth: WebhookAuth;
		deliveryIdHeader: string | null | undefined;
		filter: readonly WebhookCondition[] | undefined;
		secretEncrypted: string | null;
		secretDigest: string | null;
		secret: string | null;
	},
	WebhookSecretTooShort | WebhookDeliveryIdHeaderRejected
> {
	const currentSettings = current?.settings.kind === "webhook" ? current.settings : undefined;
	const auth = input.auth ?? currentSettings?.auth ?? DEFAULT_WEBHOOK_AUTH;
	const deliveryIdHeader =
		input.deliveryIdHeader !== undefined
			? input.deliveryIdHeader
			: currentSettings?.deliveryIdHeader;
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
	const hashOnly = current?.secretDigest != null && auth.kind !== "bearer";
	if (current && !hashOnly && input.secret === undefined) {
		return Effect.succeed({
			auth,
			deliveryIdHeader,
			filter,
			secretEncrypted: current.secretEncrypted,
			secretDigest: current.secretDigest,
			secret: null,
		});
	}
	if (input.secret === null) {
		return Effect.succeed({
			auth,
			deliveryIdHeader,
			filter,
			secretEncrypted: null,
			secretDigest: null,
			secret: null,
		});
	}
	const secret = input.secret ?? generateSecret(auth.kind);
	return Effect.succeed({
		auth,
		deliveryIdHeader,
		filter,
		secretEncrypted: credentials.encrypt(secret),
		secretDigest: null,
		secret,
	});
}
