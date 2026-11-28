import type {
	AcceptedRun,
	Automation,
	AutomationState,
	AutomationTriggerInput,
	AutomationUpdate,
	GitHubTrigger,
	NewAutomation,
	WebhookAuth,
	WebhookFilterTest,
} from "@sugabots/contracts";
import {
	DEFAULT_DELIVERY_ID_HEADER,
	MAX_AUTOMATION_TRIGGERS,
	webhookSecretLongEnough,
} from "@sugabots/contracts";
import {
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	type AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	AutomationTriggerRejected,
	TooManyAutomationTriggers,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretRestricted,
	WebhookSecretTooShort,
} from "@sugabots/contracts/errors/automations";
import { ApprovalNeeded } from "@sugabots/contracts/errors/proofs";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import type { Actor } from "../../authorization/permissions.ts";
import { type Database, query, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger, connector } from "../../database/schema.ts";
import { administers } from "../../proofs/facts.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import {
	automationWithTriggers,
	findSoleRoutineId,
	inScope,
	lockTriggers,
	type RoutineInput,
	type Scope,
	stateWithPendingPause,
	toAutomation,
	triggersOf,
} from "./automation.ts";
import { type InvalidRoutineSchedule, nextOccurrence } from "./schedule.ts";
import { AutomationStore } from "./store.ts";
import { generateSecret } from "./webhook-auth.ts";

/** An automation as defined, with the secrets made for its webhook triggers by this write. */
export interface Defined {
	automation: Automation;
	secrets: Array<{ triggerId: string; secret: string }>;
}

/** Who an automation is recorded as made by: a member, and the bot that made it for them, if one did. */
interface Maker {
	readonly createdById: string;
	readonly createdByBotId: string | null;
}

/** The writes, built over the automation store and the secrets cipher. */
export const makeAutomationWrites = Effect.gen(function* () {
	const store = yield* AutomationStore.Service;
	const secrets = yield* Secrets.Service;
	const acceptTrigger = yield* makeAcceptTrigger;

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
				...AutomationStore.NO_WEBHOOK_SECRET,
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
							...checked.secretValues,
							nextScheduledAt: null,
						},
						secret: checked.secret,
					};
				}
				case "github": {
					const saved = current?.settings;
					const keptRepository =
						current?.migratedGitHubConnectorId === input.connectorId &&
						saved?.kind === "github" &&
						saved.connectorId === input.connectorId &&
						saved.repository.toLowerCase() === input.repository.toLowerCase()
							? saved.repository
							: undefined;
					const repository = keptRepository ?? (yield* findConnectedRepository(project, input));
					return {
						values: {
							...AutomationStore.NO_WEBHOOK_SECRET,
							settings: { ...input, repository, events: [...new Set(input.events)] },
							nextScheduledAt: null,
							migratedGitHubConnectorId: keptRepository === undefined ? null : input.connectorId,
						},
						secret: null,
					};
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
			if (
				input.state &&
				(row.state !== current.state || current.pauseAfterFailuresPendingAt !== null)
			) {
				yield* reschedule(scope.automationId, row.state);
			}
			return row;
		});

	const insertAutomation = (
		project: { id: string; workspaceId: string },
		maker: Maker,
		input: Pick<NewAutomation, "name" | "instructions">,
		state: AutomationState,
		written: Written[],
	) =>
		Effect.gen(function* () {
			const row = yield* store.create({
				workspaceId: project.workspaceId,
				projectId: project.id,
				createdById: maker.createdById,
				createdByBotId: maker.createdByBotId,
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
			} satisfies Defined;
		});

	return {
		/**
		 * Defines an automation in `project`, made by `maker`, returning the
		 * secrets made for its webhook triggers.
		 */
		create: <E>(
			project: { id: string; workspaceId: string },
			maker: Maker,
			input: NewAutomation,
			fence: Effect.Effect<void, E, Database>,
		) =>
			transaction(
				Effect.gen(function* () {
					yield* fence;
					const state = input.state ?? "enabled";
					const written = yield* Effect.forEach(input.triggers, (trigger) =>
						triggerValues(project, trigger, undefined, state),
					);
					return yield* insertAutomation(project, maker, input, state, written);
				}),
			),

		createWithRoutine: <E>(
			project: { id: string; workspaceId: string },
			maker: Maker,
			input: Pick<NewAutomation, "name" | "instructions">,
			routine: RoutineInput,
			fence: Effect.Effect<void, E, Database>,
		) =>
			transaction(
				Effect.gen(function* () {
					yield* fence;
					const written = yield* routineValues(routine, "enabled");
					const { automation } = yield* insertAutomation(project, maker, input, "enabled", [
						written,
					]);
					return automation;
				}),
			),

		/**
		 * Changes an automation's own settings. Pausing it stops its routines;
		 * enabling it again sets when each runs next from now.
		 */
		update: <E>(scope: Scope, input: AutomationUpdate, fence: Effect.Effect<void, E, Database>) =>
			transaction(
				Effect.gen(function* () {
					yield* fence;
					yield* lockTriggers(scope.automationId);
					const current = yield* automationIn(scope);
					const row = yield* changeSettings(scope, current, input);
					return { automation: yield* automationWithTriggers(row), secrets: [] } satisfies Defined;
				}),
			),

		/**
		 * Changes an automation's own settings, as `update` does, and makes the
		 * routine all that starts it, in one transaction: rewrites its one routine,
		 * or adds it when nothing starts the automation yet. Refused, changing
		 * nothing, when it has another routine or a trigger.
		 */
		updateWithSoleRoutine: <E>(
			scope: Scope,
			input: AutomationUpdate,
			routine: RoutineInput,
			approvedRoutineId: string | null,
			fence: Effect.Effect<void, E, Database>,
		) =>
			transaction(
				Effect.gen(function* () {
					yield* fence;
					// Held across the check and both writes, so a trigger added meanwhile
					// waits, and a refused routine leaves the settings as they were.
					yield* lockTriggers(scope.automationId);
					const current = yield* automationIn(scope);
					const routineId = yield* findSoleRoutineId(scope.automationId);
					if (routineId !== approvedRoutineId) return yield* new ApprovalNeeded();
					// Written as the settings leave it, running or paused.
					const written = yield* routineValues(
						routine,
						input.state ?? stateWithPendingPause(current),
					);
					if (routineId !== null) yield* store.updateTrigger(scope, routineId, written.values);
					else yield* store.addTriggers(scope, [written.values]);
					// The sole routine was just written for the state the settings leave.
					const row = yield* writeSettings(scope, current, input);
					return { automation: yield* automationWithTriggers(row), secrets: [] } satisfies Defined;
				}),
			),

		/** Adds a trigger to an automation, returning a secret made for a webhook. */
		addTrigger: (scope: Scope, input: AutomationTriggerInput) =>
			transaction(
				Effect.gen(function* () {
					yield* lockTriggers(scope.automationId);
					const current = yield* automationIn(scope);
					const existing = (yield* triggersOf([scope.automationId])).get(scope.automationId) ?? [];
					if (existing.length >= MAX_AUTOMATION_TRIGGERS) {
						return yield* new TooManyAutomationTriggers();
					}
					const written = yield* triggerValues(
						{ id: scope.projectId, workspaceId: scope.workspaceId },
						input,
						undefined,
						stateWithPendingPause(current),
					);
					const added = yield* store.addTriggers(scope, [written.values]);
					return {
						automation: yield* automationWithTriggers(current),
						secrets: secretsMade(added, [written]),
					} satisfies Defined;
				}),
			),

		/**
		 * Rewrites one of an automation's triggers, which keeps its kind. A webhook's
		 * secret is kept unless one is brought; one made for it is returned.
		 */
		updateTrigger: (scope: Scope, triggerId: string, input: AutomationTriggerInput) =>
			transaction(
				Effect.gen(function* () {
					// Held until the change is written, so an edit made meanwhile, or a
					// secret replaced meanwhile, is read here rather than written over.
					yield* lockTriggers(scope.automationId);
					const current = yield* automationIn(scope);
					const trigger = yield* triggerIn(scope, triggerId);
					if (trigger.kind !== input.kind) return yield* new AutomationTriggerKindChanged();
					if (
						input.kind === "webhook" &&
						input.auth !== undefined &&
						input.auth.kind !== "bearer" &&
						input.secret === undefined &&
						trigger.legacyBearerSecretDigest !== null
					) {
						return yield* new AutomationTriggerRejected();
					}
					const written = yield* triggerValues(
						{ id: scope.projectId, workspaceId: scope.workspaceId },
						input,
						trigger,
						stateWithPendingPause(current),
					);
					const updated = yield* store.updateTrigger(scope, triggerId, written.values);
					if (!updated) return yield* new AutomationTriggerNotFound();
					return {
						automation: yield* automationWithTriggers(current),
						secrets: secretsMade([updated], [written]),
					} satisfies Defined;
				}),
			),

		removeTrigger: (scope: Scope, triggerId: string) =>
			transaction(
				Effect.gen(function* () {
					yield* lockTriggers(scope.automationId);
					const current = yield* automationIn(scope);
					if (!(yield* store.removeTrigger(scope, triggerId))) {
						return yield* new AutomationTriggerNotFound();
					}
					return yield* automationWithTriggers(current);
				}),
			),

		remove: (scope: Scope) =>
			transaction(
				Effect.gen(function* () {
					yield* lockTriggers(scope.automationId);
					if (!(yield* store.remove(scope))) return yield* new AutomationNotFound();
				}),
			),

		/** A webhook trigger's current secret. */
		currentSecret: (scope: Scope, triggerId: string, actor: Actor) =>
			Effect.gen(function* () {
				yield* automationIn(scope);
				const trigger = yield* triggerIn(scope, triggerId);
				if (trigger.settings.kind !== "webhook") return yield* new AutomationTriggerRejected();
				if (trigger.secretRestrictedToAdmins) {
					if (trigger.legacyBearerSecretDigest !== null) return { kind: "legacy" as const };
					if (!administers(actor)) return yield* new WebhookSecretRestricted();
				}
				if (trigger.secretEncrypted === null) return { kind: "none" as const };
				return { kind: "set" as const, secret: secrets.decrypt(trigger.secretEncrypted) };
			}),

		/**
		 * Replaces a webhook trigger's secret with `brought`, with a new one when
		 * it is absent, or with none when it is null, and returns it.
		 */
		replaceSecret: (scope: Scope, triggerId: string, brought: string | null | undefined) =>
			transaction(
				Effect.gen(function* () {
					yield* lockTriggers(scope.automationId);
					yield* automationIn(scope);
					const trigger = yield* triggerIn(scope, triggerId);
					if (trigger.settings.kind !== "webhook") return yield* new AutomationTriggerRejected();
					const { auth } = trigger.settings;
					if (brought != null && !webhookSecretLongEnough(auth.kind, brought)) {
						return yield* new WebhookSecretTooShort();
					}
					const secret = brought === undefined ? generateSecret(auth.kind) : brought;
					const sealed = secret === null ? null : secrets.encrypt(secret);
					if (!(yield* store.replaceWebhookSecret(scope, triggerId, sealed))) {
						return yield* new AutomationTriggerNotFound();
					}
					return secret;
				}),
			),

		/**
		 * Runs the automation now, for `requestedByMemberId`: opens its chat,
		 * posts the trigger, and queues the run. Asking again with the same
		 * `requestId` returns that run again, as a duplicate.
		 */
		startManualRun: (
			scope: Scope,
			requestedByMemberId: string,
			requestId: string,
			mayResumeAfterFailures: boolean,
		): Effect.Effect<
			AcceptedRun,
			AutomationNotFound | AutomationTriggerConflict | AutomationTriggerRejected,
			Database
		> =>
			transaction(
				Effect.gen(function* () {
					const accepted = yield* acceptTrigger({
						...scope,
						triggerId: null,
						triggerIdentity: requestId,
						trigger: {
							kind: "manual",
							requestId,
							requestedAt: DateTime.formatIso(yield* DateTime.now),
							requestedByMemberId,
						},
					});
					if (accepted.duplicate || !mayResumeAfterFailures) return accepted;
					if (yield* store.resumeAfterFailures(scope.automationId)) {
						// A routine it was saved with is one that has a next time.
						yield* Effect.orDie(reschedule(scope.automationId, "enabled"));
					}
					return accepted;
				}),
			),
	};
});

/** What a trigger is written as, and the secret made for it, if this made one. */
interface Written {
	values: AutomationStore.TriggerValues;
	secret: string | null;
}

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
 * findConnectedRepository returns the repository as the project's connector
 * spells it, since GitHub's names ignore case.
 */
const findConnectedRepository = (
	project: { id: string; workspaceId: string },
	trigger: GitHubTrigger,
): Effect.Effect<string, AutomationRepositoryNotConnected, Database> =>
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
		return found.path;
	});

/** What a new webhook trigger checks its callers with until somebody chooses. */
const DEFAULT_WEBHOOK_AUTH: WebhookAuth = { kind: "bearer" };

/**
 * How a webhook trigger written as `input` checks its callers, and which of
 * their calls it runs, given how it did before (`current`, absent for a new
 * one). The filter is kept unless one is brought, and none is `undefined`.
 * An edit keeps the current secret unless it supplies a replacement. A null
 * secret opens the webhook. A new webhook without a supplied secret gets one
 * generated for it. A source's secret can be as long as the source makes it.
 */
function webhookCheck(
	secrets: Secrets.Interface,
	input: Extract<AutomationTriggerInput, { kind: "webhook" }>,
	current: schema.AutomationTriggerRow | undefined,
): Effect.Effect<
	{
		auth: WebhookAuth;
		deliveryIdHeader: string | null | undefined;
		filter: readonly WebhookFilterTest[] | undefined;
		secretValues: AutomationStore.WebhookSecretValues;
		secret: string | null;
	},
	WebhookSecretTooShort | WebhookDeliveryIdHeaderRejected
> {
	const currentSettings = current?.settings.kind === "webhook" ? current.settings : undefined;
	const auth = input.auth ?? currentSettings?.auth ?? DEFAULT_WEBHOOK_AUTH;
	const requestedHeader = input.deliveryIdHeader;
	const deliveryIdHeader =
		requestedHeader === undefined
			? currentSettings
				? currentSettings.deliveryIdHeader
				: DEFAULT_DELIVERY_ID_HEADER
			: typeof requestedHeader === "object" && requestedHeader !== null
				? undefined
				: requestedHeader;
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
			secretValues: {
				secretEncrypted: current.secretEncrypted,
				legacyBearerSecretDigest: current.legacyBearerSecretDigest,
				secretRestrictedToAdmins: current.secretRestrictedToAdmins,
			},
			secret: null,
		});
	}
	if (input.secret === null) {
		return Effect.succeed({
			auth,
			deliveryIdHeader,
			filter,
			secretValues: AutomationStore.NO_WEBHOOK_SECRET,
			secret: null,
		});
	}
	const secret = input.secret ?? generateSecret(auth.kind);
	return Effect.succeed({
		auth,
		deliveryIdHeader,
		filter,
		secretValues: {
			...AutomationStore.NO_WEBHOOK_SECRET,
			secretEncrypted: secrets.encrypt(secret),
		},
		secret,
	});
}
