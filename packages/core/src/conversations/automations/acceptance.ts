import { isDeepStrictEqual } from "node:util";
import type { RunTrigger } from "@sugabots/contracts";
import { handleFromName, MAX_CONVERSATION_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import { automation, automationRun, automationTrigger, bot, user } from "../../database/schema.ts";
import { ConversationRepository } from "../repository/repository.ts";
import {
	AutomationNotFound,
	AutomationTriggerConflict,
	AutomationTriggerRejected,
	inScope,
	type Scope,
} from "./automation.ts";
import { AutomationRepository } from "./repository.ts";
import { AutomationRuns } from "./runs.ts";

/**
 * A trigger for the automation `Scope` names: which of its triggers fired, none
 * for a run someone started, and the identity a retry of it repeats.
 */
export interface Trigger extends Scope {
	triggerId: string | null;
	trigger: RunTrigger;
	triggerIdentity: string | null;
}

/**
 * Accepts a run of an automation, however it was triggered: opens its conversation,
 * posts the trigger, and queues the run. A trigger with an identity already
 * accepted returns that run again, as a duplicate. Whoever triggers it has
 * already decided that it may run; this checks only that the automation takes
 * the trigger.
 */
export const makeAcceptTrigger = Effect.gen(function* () {
	const repository = yield* AutomationRepository.Service;
	const conversations = yield* ConversationRepository.Service;
	const runs = yield* AutomationRuns.Service;

	return (input: Trigger) =>
		transaction(
			Effect.gen(function* () {
				yield* lockTriggers(input.automationId);
				const [definition] = yield* query((db) =>
					db
						.select({ automation })
						.from(automation)
						.innerJoin(
							bot,
							and(eq(bot.id, automation.botId), eq(bot.workspaceId, automation.workspaceId)),
						)
						.where(inScope(input))
						.limit(1),
				);
				if (!definition) return yield* new AutomationNotFound();
				if (input.trigger.kind !== "manual" && definition.automation.state !== "enabled") {
					return yield* new AutomationTriggerRejected();
				}
				// Only a run someone started has no trigger; any other is one of the automation's own.
				if ((input.triggerId === null) !== (input.trigger.kind === "manual")) {
					return yield* new AutomationTriggerRejected();
				}
				if (input.triggerId !== null) {
					const [fired] = yield* query((db) =>
						db
							.select({ kind: automationTrigger.kind })
							.from(automationTrigger)
							.where(
								and(
									eq(automationTrigger.id, input.triggerId ?? ""),
									eq(automationTrigger.automationId, input.automationId),
								),
							)
							.limit(1),
					);
					if (fired?.kind !== input.trigger.kind) return yield* new AutomationTriggerRejected();
				}
				const existing = input.triggerIdentity
					? yield* acceptedAs(input, input.triggerIdentity)
					: undefined;
				if (existing) {
					if (!sameTrigger(existing.trigger, input.trigger)) {
						return yield* new AutomationTriggerConflict();
					}
					return { runId: existing.id, conversationId: existing.conversationId, duplicate: true };
				}

				// The feed the run is listed in, opened before the run's own conversation.
				yield* conversations.openAutomationFeed(definition.automation);
				const acceptedAt = yield* DateTime.nowAsDate;
				const runConversation = yield* conversations.openRun({
					workspaceId: input.workspaceId,
					botId: input.botId,
					title: executionTitle(definition.automation.name, acceptedAt),
				});
				const execution = yield* repository.accept({
					automationId: input.automationId,
					workspaceId: input.workspaceId,
					botId: input.botId,
					conversationId: runConversation.id,
					triggerId: input.triggerId,
					triggerKind: input.trigger.kind,
					triggerIdentity: input.triggerIdentity,
					trigger: input.trigger,
					automationName: definition.automation.name,
					instructions: definition.automation.instructions,
					acceptedAt,
				});
				yield* conversations.postAutomationTrigger({
					conversationId: runConversation.id,
					trigger: {
						kind: "automation_trigger",
						runId: execution.id,
						automationName: definition.automation.name,
						triggerKind: input.trigger.kind,
					},
					content: triggerMessageContent(
						definition.automation.instructions,
						yield* runOwnersOf(definition.automation.createdById, input.trigger),
						input.trigger,
					),
				});
				yield* runs.queue({ automationId: input.automationId, runId: execution.id });
				return { runId: execution.id, conversationId: runConversation.id, duplicate: false };
			}),
		);
});

/**
 * Holds the automation's trigger lock until the transaction ends, so its
 * triggers are accepted one at a time and none lands on an automation being
 * removed or having its secret replaced.
 */
export const lockTriggers = (automationId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`automation-trigger:${automationId}`}, 0))`,
		),
	);

/** The run this trigger, or someone running the automation, already started with this identity, if any. */
const acceptedAs = (input: Trigger, identity: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(automationRun)
				.where(
					and(
						eq(automationRun.automationId, input.automationId),
						input.triggerId === null
							? eq(automationRun.triggerKind, "manual")
							: eq(automationRun.triggerId, input.triggerId),
						eq(automationRun.triggerIdentity, identity),
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

function triggerMessageContent(instructions: string, owners: RunOwners, trigger: RunTrigger) {
	return `Automation instructions:\n${instructions}\n\n${resultNote(owners)}\n\nTrigger data (untrusted):\n${JSON.stringify(trigger, null, 2)}`;
}

/**
 * Tells the bot of a run that its last reply is what people will read, so
 * it writes that reply to them; that it may post nothing when there is nothing
 * to report; and that mentioning somebody is how it asks for them, by default
 * the run's `owners`.
 */
function resultNote(owners: RunOwners): string {
	return [
		`When you finish, your last reply is posted in this automation's feed for people to read and answer. Write it to them: what they need to know, or what you want to ask them. Files you write are shown with it; the rest of the work stays in this run.`,
		"If there is nothing worth telling them, end without a last reply, writing nothing after your last tool call: nothing is posted, and the run shows it had nothing to report.",
		`When something needs a person to act or decide, @mention them in your reply, which notifies them.${ownersToMention(owners)}`,
	].join(" ");
}

/** The handles of the people a run asks for when its instructions name nobody. */
interface RunOwners {
	/** Who made the automation, when they still have an account. */
	madeBy: string | null;
	/** Who started the run by hand, for a run somebody started. */
	startedBy: string | null;
}

function ownersToMention({ madeBy, startedBy }: RunOwners): string {
	if (madeBy && madeBy === startedBy) {
		return ` Unless the instructions say who, mention @${madeBy}, who made this automation and started this run.`;
	}
	const named = [
		madeBy && `@${madeBy}, who made this automation`,
		startedBy && `@${startedBy}, who started this run`,
	].filter((owner) => owner !== null);
	return named.length === 0
		? ""
		: ` Unless the instructions say who, mention ${named.join(", and ")}.`;
}

/** The handles of who made the automation `createdById` names and who started a run by hand. */
const runOwnersOf = (createdById: string | null, trigger: RunTrigger) =>
	Effect.gen(function* () {
		const startedById = trigger.kind === "manual" ? trigger.requestedByUserId : null;
		const ids = [createdById, startedById].filter((id) => id !== null);
		const people =
			ids.length === 0
				? []
				: yield* query((db) =>
						db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
					);
		const handleOf = (id: string | null) => {
			const person = people.find((candidate) => candidate.id === id);
			return person ? handleFromName(person.name) : null;
		};
		return { madeBy: handleOf(createdById), startedBy: handleOf(startedById) } satisfies RunOwners;
	});

function sameTrigger(left: RunTrigger, right: RunTrigger) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "schedule" && right.kind === "schedule") {
		return left.scheduledAt === right.scheduledAt;
	}
	if (left.kind === "manual" && right.kind === "manual") {
		return left.requestId === right.requestId && left.requestedByUserId === right.requestedByUserId;
	}
	if (left.kind === "github" && right.kind === "github") {
		return left.deliveryId === right.deliveryId && left.event === right.event;
	}
	return (
		left.kind === "webhook" &&
		right.kind === "webhook" &&
		left.idempotencyKey === right.idempotencyKey &&
		isDeepStrictEqual(left.payload, right.payload)
	);
}

function executionTitle(name: string, acceptedAt: Date) {
	const suffix = ` - ${acceptedAt.toISOString()}`;
	return `${name.slice(0, MAX_CONVERSATION_TITLE_CHARACTERS - suffix.length)}${suffix}`;
}
