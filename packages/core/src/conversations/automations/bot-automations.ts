export * as BotAutomations from "./bot-automations.ts";

import type {
	Automation,
	AutomationSchedule,
	AutomationTrigger,
	RepositoryEvent,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { bot, workspace } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import type { UserFacing } from "../../user-message.ts";
import type {
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { Automations } from "./automations.ts";
import type { AutomationRepository } from "./repository.ts";
import type { InvalidAutomationSchedule } from "./schedule.ts";

/**
 * A bot's own automations, as it reads and changes them in a conversation, for
 * the person whose message it is answering and with their permissions. It
 * cannot act for nobody: a turn answering another bot, or an automation's
 * trigger, is refused.
 *
 * A bot sets up automations on one schedule, in its workspace's timezone, and
 * records itself as their maker; it changes that schedule while it is the
 * automation's only trigger. Other triggers are set up in settings: a webhook's
 * secret is shown once, so one made here would leave it in the conversation.
 */
export interface Interface {
	readonly list: (bot: Bot) => Effect.Effect<BotAutomation[], Refused>;
	readonly create: (bot: Bot, input: NewBotAutomation) => Effect.Effect<BotAutomation, Refused>;
	/** Changes one of the bot's automations. Its schedule changes only while that is its only trigger. */
	readonly update: (
		bot: Bot,
		automationId: string,
		changes: BotAutomationChanges,
	) => Effect.Effect<BotAutomation, Refused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/BotAutomations",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotAutomations");
	const automations = yield* Automations.Service;
	const installation = yield* Installation.Service;

	/** Where the bot lives: its workspace's timezone, and where its automations' pages are. */
	const placeOf = (botId: string) =>
		Effect.flatMap(
			query((db) =>
				db
					.select({
						timeZone: workspace.timeZone,
						workspaceSlug: workspace.slug,
						handle: bot.handle,
					})
					.from(bot)
					.innerJoin(workspace, eq(workspace.id, bot.workspaceId))
					.where(eq(bot.id, botId))
					.limit(1),
			),
			([row]) =>
				row
					? Effect.succeed({
							timeZone: row.timeZone,
							automationsUrl: `${installation.webAppUrl}/${row.workspaceSlug}/bots/${row.handle}/automations`,
						})
					: Effect.die(new Error("A bot with automations is not in a workspace")),
		);

	/**
	 * Runs `work` as the person the bot is answering. They signed in to post
	 * the message the turn answers, which is the claim `vouchedFor` makes.
	 */
	const forAsker = <A, E>(
		bot: Bot,
		work: Effect.Effect<A, E | AuthorizationDenied, CurrentActor.Service>,
	) =>
		bot.askedBy
			? work.pipe(
					CurrentActor.provide(AuthenticatedUserId.vouchedFor(bot.askedBy)),
					Effect.catchTag(["ActionForbidden", "ResourceHidden"], () =>
						Effect.fail(new MayNotManageAutomations()),
					),
				)
			: Effect.fail(new NobodyAsked());

	return Service.of({
		list: (bot) =>
			operation(
				"list",
				Effect.gen(function* () {
					const listed = yield* forAsker(bot, automations.list({ botId: bot.botId }));
					const place = yield* placeOf(bot.botId);
					return listed.map((automation) => toBotAutomation(automation, place.automationsUrl));
				}),
			),

		create: (bot, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.botId);
					const defined = yield* forAsker(
						bot,
						automations.create(
							{ botId: bot.botId, madeByBot: true },
							{
								name: input.name,
								instructions: input.instructions,
								triggers: [
									{
										kind: "schedule",
										schedule: { repeat: "cron", expression: input.schedule },
										timezone: place.timeZone,
									},
								],
							},
						),
					);
					return toBotAutomation(defined.automation, place.automationsUrl);
				}),
			),

		update: (bot, automationId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.botId);
					const addressed = { botId: bot.botId, automationId };
					const current = yield* forAsker(bot, automations.get(addressed));
					const [only, ...others] = current.triggers;
					if (changes.schedule !== undefined && (only?.kind !== "schedule" || others.length > 0)) {
						return yield* new TriggerSetInSettings();
					}
					const updated = yield* forAsker(
						bot,
						automations.update(addressed, {
							name: changes.name,
							instructions: changes.instructions,
							state:
								changes.paused === undefined ? undefined : changes.paused ? "paused" : "enabled",
						}),
					);
					if (changes.schedule === undefined || !only) {
						return toBotAutomation(updated.automation, place.automationsUrl);
					}
					const rescheduled = yield* forAsker(
						bot,
						automations.updateTrigger(
							{ ...addressed, triggerId: only.id },
							{
								kind: "schedule",
								schedule: { repeat: "cron", expression: changes.schedule },
								timezone: place.timeZone,
							},
						),
					);
					return toBotAutomation(rescheduled.automation, place.automationsUrl);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/**
 * Suspended, because `Automations` reaches the turn's steps, which reach this
 * module: `Automations.layer` is read once the layer is built, not while the
 * modules load.
 */
export const layer = Layer.suspend(() => layerNoDeps.pipe(Layer.provide(Automations.layer)));

/** The bot and the person whose message it is answering, if a person asked. */
export interface Bot {
	readonly botId: string;
	readonly askedBy: string | null;
}

/** An automation as the bot reads it back. */
export interface BotAutomation {
	id: string;
	name: string;
	instructions: string;
	/**
	 * What starts it: each schedule and the timezone it runs in, a webhook, or
	 * a repository's events. A schedule the bot set is a cron expression; one
	 * picked in settings is by its days and times. With none, it runs only when
	 * someone runs it.
	 */
	when: Array<
		| { kind: "schedule"; schedule: AutomationSchedule; timezone: string; nextRunAt: string | null }
		| { kind: "webhook" }
		| { kind: "github"; repository: string; events: readonly RepositoryEvent[] }
	>;
	paused: boolean;
	/** The automation's own settings page, for a link in the bot's reply. */
	settingsUrl: string;
}

export interface NewBotAutomation {
	name: string;
	instructions: string;
	/** A five-field cron expression, in the workspace's timezone. */
	schedule: string;
}

export interface BotAutomationChanges {
	name?: string;
	instructions?: string;
	schedule?: string;
	paused?: boolean;
}

function whenOf(trigger: AutomationTrigger): BotAutomation["when"][number] {
	switch (trigger.kind) {
		case "schedule":
			return {
				kind: "schedule",
				schedule: trigger.schedule,
				timezone: trigger.timezone,
				nextRunAt: trigger.nextScheduledAt,
			};
		case "webhook":
			return { kind: "webhook" };
		case "github":
			return { kind: "github", repository: trigger.repository, events: trigger.events };
	}
}

function toBotAutomation(automation: Automation, automationsUrl: string): BotAutomation {
	return {
		id: automation.id,
		name: automation.name,
		instructions: automation.instructions,
		when: automation.triggers.map(whenOf),
		paused: automation.state === "paused",
		settingsUrl: `${automationsUrl}/${automation.id}`,
	};
}

/** Why the bot could not do what it was asked, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| MayNotManageAutomations
	| TriggerSetInSettings
	| AutomationNotFound
	| AutomationRepository.AutomationNameTaken
	| InvalidAutomationSchedule
	| WebhookSecretTooShort
	| WebhookDeliveryIdHeaderRejected
	| AutomationRepositoryNotConnected
	| AutomationTriggerNotFound
	| AutomationTriggerKindChanged;

export class NobodyAsked extends Data.TaggedError("NobodyAsked") implements UserFacing {
	get userMessage() {
		return userText`Only a person can ask a bot to read or change its automations, and this turn answers no one.`;
	}
}

export class MayNotManageAutomations
	extends Data.TaggedError("MayNotManageAutomations")
	implements UserFacing
{
	get userMessage() {
		return userText`The person asking may not do that: only the bot's creator or an admin can have it set up or change its automations.`;
	}
}

export class TriggerSetInSettings
	extends Data.TaggedError("TriggerSetInSettings")
	implements UserFacing
{
	get userMessage() {
		return userText`That automation has triggers other than one schedule, which only its settings can change. Its name, instructions and whether it is paused can still be changed here.`;
	}
}
