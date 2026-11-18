import {
	MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS,
	MAX_AUTOMATION_NAME_CHARACTERS,
	MAX_CRON_EXPRESSION_CHARACTERS,
} from "@sugabots/contracts";
import { type Tool, tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotAutomations } from "../../automations/bot-automations.ts";
import { noInputSchema } from "../no-input.ts";

const LIST_AUTOMATIONS_TOOL = "list_automations";
const CREATE_AUTOMATION_TOOL = "create_automation";
const UPDATE_AUTOMATION_TOOL = "update_automation";

/** The `disabledTools` key, and `builtInToolCatalog` entry, that switches off every automation tool. */
export const AUTOMATIONS_KEY = "automations";

/** The automation tools, which an admin switches off together as {@link AUTOMATIONS_KEY}. */
export const AUTOMATION_TOOLS = [
	LIST_AUTOMATIONS_TOOL,
	CREATE_AUTOMATION_TOOL,
	UPDATE_AUTOMATION_TOOL,
] as const;

/** Whether an automation tool changes something, so a turn that dies after calling it is not retried blindly. */
export const AUTOMATION_TOOL_MUTATES: Record<(typeof AUTOMATION_TOOLS)[number], boolean> = {
	[LIST_AUTOMATIONS_TOOL]: false,
	[CREATE_AUTOMATION_TOOL]: true,
	[UPDATE_AUTOMATION_TOOL]: true,
};

type Refusal = { refused: string };

/**
 * A timezone as people say it: "Sydney time" for `Australia/Sydney`, "New
 * York time" for `America/New_York`, and "UTC" as itself.
 */
export function spokenTimeZone(timeZone: string): string {
	if (timeZone === "UTC" || timeZone.startsWith("Etc/")) return "UTC";
	const city = timeZone.split("/").at(-1)?.replaceAll("_", " ") ?? timeZone;
	return `${city} time`;
}

const name = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_NAME_CHARACTERS),
).annotate({ description: "A short name people will recognise, such as Morning standup." });

const instructions = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS),
).annotate({
	description:
		"What you will do each time it runs, written to yourself as the person would ask you in the chat.",
});

/**
 * The automation tools: a bot lists, sets up and changes its own automations, for
 * the person whose message it is answering. Schedules are cron expressions in
 * `timeZone`, the workspace's, which their descriptions name as people say it.
 */
export function automationTools({
	bot,
	timeZone,
	automations,
	run,
}: {
	bot: BotAutomations.Bot;
	timeZone: string;
	automations: BotAutomations.Interface;
	run: RunEffect;
}): Record<(typeof AUTOMATION_TOOLS)[number], Tool> {
	const zone = `${spokenTimeZone(timeZone)} (${timeZone})`;
	const schedule = Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
	).annotate({
		description: `A five-field cron expression in ${zone}: "0 9 * * 1-5" is 9:00 on weekdays.`,
	});

	/** Runs `work`, handing a refusal back to the model as words it can pass on. */
	const answer = <A>(work: Effect.Effect<A, BotAutomations.Refused>) =>
		run(
			work.pipe(
				Effect.catch(
					(refusal): Effect.Effect<A | Refusal> => Effect.succeed({ refused: refusal.userMessage }),
				),
			),
		);

	return {
		[LIST_AUTOMATIONS_TOOL]: tool({
			description:
				"List your automations: the jobs you do without being asked, with what starts each (its schedules, webhooks or repository events), and whether it is paused. Check here before setting up an automation, so you change one that exists rather than make a second.",
			inputSchema: noInputSchema,
			execute: () =>
				answer(Effect.map(automations.list(bot), (listed) => ({ automations: listed }))),
		}),
		[CREATE_AUTOMATION_TOOL]: tool({
			description: `Set up an automation: a job you do on a schedule without being asked, such as a 9am standup or a weekly report. Only when the person asks for one, or agrees to one you suggest. Schedules run in ${zone}. When it is set up, tell them when it runs and link its name to the settingsUrl you get back, where they can change or remove it.`,
			inputSchema: Schema.Struct({ name, instructions, schedule }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: (input) =>
				answer(Effect.map(automations.create(bot, input), (automation) => ({ automation }))),
		}),
		[UPDATE_AUTOMATION_TOOL]: tool({
			description: `Change one of your automations, by the id list_automations gives: its name, instructions, schedule, or whether it is paused. Give only what changes. Schedules run in ${zone}. Its schedule can be changed here only while that schedule is all that starts it; other triggers are changed in its settings.`,
			inputSchema: Schema.Struct({
				automationId: Schema.String.check(Schema.isUUID()).annotate({
					description: "The automation's id, from list_automations.",
				}),
				name: Schema.optional(name),
				instructions: Schema.optional(instructions),
				schedule: Schema.optional(schedule),
				paused: Schema.optional(
					Schema.Boolean.annotate({ description: "true pauses it; false sets it running again." }),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: ({ automationId, ...changes }) =>
				answer(
					Effect.map(automations.update(bot, automationId, changes), (automation) => ({
						automation,
					})),
				),
		}),
	};
}
