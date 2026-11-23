export * as BotAutomations from "./bot-automations.ts";

import type {
	Automation,
	AutomationTrigger,
	RepositoryEvent,
	RoutineSchedule,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { asAsker, type CurrentActor, type NobodyAsked } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { bot, project, workspace } from "../../database/schema.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { automationsPagePath } from "../../server-settings/web-app-paths.ts";
import type { UserFacing } from "../../user-message.ts";
import type {
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	TriggerSetInSettings,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "./automation.ts";
import { Automations } from "./automations.ts";
import type { InvalidRoutineSchedule } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";

/**
 * The automations of the project a bot is working in, as it reads and changes
 * them in a chat there, for the person whose message it is answering
 * and with their permissions: in its own chats, its default project's, which
 * are its own. It cannot act for nobody: a turn answering another bot, or an
 * automation's run, is refused.
 *
 * A bot sets up automations with one routine, in its workspace's timezone,
 * and records itself as their maker; the project's lead bot runs them. It
 * changes that routine while the routine is all that starts the automation,
 * and gives one to an automation nothing starts yet. Triggers are set up in
 * settings: a webhook's secret is shown once, so one made here would leave it
 * in the chat.
 */
export interface Interface {
	readonly list: (bot: Bot) => Effect.Effect<BotAutomation[], Refused>;
	readonly create: (bot: Bot, input: NewBotAutomation) => Effect.Effect<BotAutomation, Refused>;
	/**
	 * Changes one of the project's automations. Its routine changes only while
	 * one routine is all that starts it, or is added when nothing starts it.
	 */
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
	const serverSettings = yield* ServerSettings.Service;

	/**
	 * Where the project is: its workspace's timezone, and the page an automation
	 * of it is set up on, the bot's for a bot's own.
	 */
	const placeOf = (projectId: string) =>
		Effect.flatMap(
			query((db) =>
				db
					.select({
						timeZone: workspace.timeZone,
						workspaceSlug: workspace.slug,
						projectSlug: project.slug,
						botHandle: bot.handle,
					})
					.from(project)
					.innerJoin(workspace, eq(workspace.id, project.workspaceId))
					.leftJoin(bot, eq(bot.id, project.defaultOfBotId))
					.where(eq(project.id, projectId))
					.limit(1),
			),
			([row]) => {
				if (!row) return Effect.die(new Error("A project with automations is not in a workspace"));
				const { workspaceSlug, projectSlug, botHandle } = row;
				const pageOf = (automationId: string) =>
					`${serverSettings.webAppUrl}${automationsPagePath(
						botHandle === null ? { workspaceSlug, projectSlug } : { workspaceSlug, botHandle },
						automationId,
					)}`;
				return Effect.succeed({ timeZone: row.timeZone, pageOf });
			},
		);

	/**
	 * Runs `work` as the person the bot is answering, who may not manage the
	 * project's automations unless it lets them.
	 */
	const forAsker = <A, E>(
		bot: Bot,
		work: Effect.Effect<A, E | AuthorizationDenied, CurrentActor.Service>,
	) =>
		asAsker(
			bot.askerId,
			work.pipe(
				Effect.catchTag(["ActionForbidden", "ResourceHidden"], () =>
					Effect.fail(new MayNotManageAutomations()),
				),
			),
		);

	return Service.of({
		list: (bot) =>
			operation(
				"list",
				Effect.gen(function* () {
					const listed = yield* forAsker(bot, automations.list({ projectId: bot.projectId }));
					const place = yield* placeOf(bot.projectId);
					return listed.map((automation) => toBotAutomation(automation, place.pageOf));
				}),
			),

		create: (bot, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.projectId);
					const defined = yield* forAsker(
						bot,
						automations.create(
							{ projectId: bot.projectId, madeByBotId: bot.botId },
							{
								name: input.name,
								instructions: input.instructions,
								triggers: [
									{
										kind: "routine",
										schedule: { repeat: "cron", expression: input.routineExpression },
										timezone: place.timeZone,
									},
								],
							},
						),
					);
					return toBotAutomation(defined.automation, place.pageOf);
				}),
			),

		update: (bot, automationId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.projectId);
					const addressed = { projectId: bot.projectId, automationId };
					const settings = {
						name: changes.name,
						instructions: changes.instructions,
						state: changes.paused === undefined ? undefined : changes.paused ? "paused" : "enabled",
					} as const;
					const updated = yield* forAsker(
						bot,
						changes.routineExpression === undefined
							? automations.update(addressed, settings)
							: automations.updateWithSoleRoutine(addressed, settings, {
									kind: "routine",
									schedule: { repeat: "cron", expression: changes.routineExpression },
									timezone: place.timeZone,
								}),
					);
					return toBotAutomation(updated.automation, place.pageOf);
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

/**
 * The bot, the project it is working in, whose automations it reads and
 * changes, and the person whose message it is answering, if a person asked.
 */
export interface Bot {
	readonly botId: string;
	readonly projectId: string;
	readonly askerId: string | null;
}

/** An automation as the bot reads it back. */
interface BotAutomation {
	id: string;
	name: string;
	instructions: string;
	/**
	 * What starts it: each routine with the timezone it runs in, a webhook, or
	 * a repository's events. A routine the bot set runs on a cron expression; one
	 * picked in settings is by its days and times. With none, it runs only when
	 * someone runs it.
	 */
	when: Array<
		| { kind: "routine"; schedule: RoutineSchedule; timezone: string; nextRunAt: string | null }
		| { kind: "webhook" }
		| { kind: "github"; repository: string; events: readonly RepositoryEvent[] }
	>;
	paused: boolean;
	/** The page the automation is set up on, for a link in the bot's reply. */
	settingsUrl: string;
}

interface NewBotAutomation {
	name: string;
	instructions: string;
	/** Its one routine, as a five-field cron expression in the workspace's timezone. */
	routineExpression: string;
}

interface BotAutomationChanges {
	name?: string;
	instructions?: string;
	/** A new five-field cron expression for its one routine. */
	routineExpression?: string;
	paused?: boolean;
}

function whenOf(trigger: AutomationTrigger): BotAutomation["when"][number] {
	switch (trigger.kind) {
		case "routine":
			return {
				kind: "routine",
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

function toBotAutomation(
	automation: Automation,
	pageOf: (automationId: string) => string,
): BotAutomation {
	return {
		id: automation.id,
		name: automation.name,
		instructions: automation.instructions,
		when: automation.triggers.map(whenOf),
		paused: automation.state === "paused",
		settingsUrl: pageOf(automation.id),
	};
}

/** Why the bot could not do what it was asked, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| MayNotManageAutomations
	| TriggerSetInSettings
	| AutomationNotFound
	| AutomationStore.AutomationNameTaken
	| InvalidRoutineSchedule
	| WebhookSecretTooShort
	| WebhookDeliveryIdHeaderRejected
	| AutomationRepositoryNotConnected;

export class MayNotManageAutomations
	extends Data.TaggedError("MayNotManageAutomations")
	implements UserFacing
{
	get userMessage() {
		return userText`The person asking may not do that: only those who manage this project's automations (for a bot's own, its creator or an admin) can have them set up or changed.`;
	}
}
