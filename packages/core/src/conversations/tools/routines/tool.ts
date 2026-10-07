import {
	MAX_CRON_EXPRESSION_CHARACTERS,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	routineResultsSchema,
} from "@sugabots/contracts";
import { type Tool, tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { BotRoutines } from "../../routines/bot-routines.ts";

export const LIST_ROUTINES_TOOL = "list_routines";
export const CREATE_ROUTINE_TOOL = "create_routine";
export const UPDATE_ROUTINE_TOOL = "update_routine";

/** The `disabledTools` key, and `builtInToolCatalog` entry, that switches off every routine tool. */
export const ROUTINES_KEY = "routines";

/** The routine tools, which an admin switches off together as {@link ROUTINES_KEY}. */
export const ROUTINE_TOOLS = [
	LIST_ROUTINES_TOOL,
	CREATE_ROUTINE_TOOL,
	UPDATE_ROUTINE_TOOL,
] as const;

/** Whether a routine tool changes something, so a turn that dies after calling it is not retried blindly. */
export const ROUTINE_TOOL_MUTATES: Record<(typeof ROUTINE_TOOLS)[number], boolean> = {
	[LIST_ROUTINES_TOOL]: false,
	[CREATE_ROUTINE_TOOL]: true,
	[UPDATE_ROUTINE_TOOL]: true,
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
	Schema.isMaxLength(MAX_ROUTINE_NAME_CHARACTERS),
).annotate({ description: "A short name people will recognise, such as Morning standup." });

const instructions = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_INSTRUCTIONS_CHARACTERS),
).annotate({
	description:
		"What you will do each time it runs, written to yourself as the person would ask you in the chat.",
});

const results = routineResultsSchema.annotate({
	description:
		"post_to_chat: your last reply of each run is posted in this chat for people to read and answer; use it for anything people should see, such as a standup, a check-in or a report. keep_in_run: the result stays inside the run; use it for work handled out of sight.",
});

/**
 * The routine tools: a bot lists, sets up and changes its own routines, for
 * the person whose message it is answering. Schedules are cron expressions in
 * `timeZone`, the workspace's, which their descriptions name as people say it.
 */
export function routineTools({
	bot,
	timeZone,
	routines,
	run,
}: {
	bot: BotRoutines.Bot;
	timeZone: string;
	routines: BotRoutines.Interface;
	run: RunEffect;
}): Record<(typeof ROUTINE_TOOLS)[number], Tool> {
	const zone = `${spokenTimeZone(timeZone)} (${timeZone})`;
	const schedule = Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
	).annotate({
		description: `A five-field cron expression in ${zone}: "0 9 * * 1-5" is 9:00 on weekdays.`,
	});

	/** Runs `work`, handing a refusal back to the model as words it can pass on. */
	const answer = <A>(work: Effect.Effect<A, BotRoutines.Refused>) =>
		run(
			work.pipe(
				Effect.catch(
					(refusal): Effect.Effect<A | Refusal> => Effect.succeed({ refused: refusal.userMessage }),
				),
			),
		);

	return {
		[LIST_ROUTINES_TOOL]: tool({
			description:
				"List your routines: the jobs you do on a schedule or when a webhook calls, with when each runs, whether it is paused, and where its result goes. Check here before setting up a routine, so you change one that exists rather than make a second.",
			inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: () => answer(Effect.map(routines.list(bot), (listed) => ({ routines: listed }))),
		}),
		[CREATE_ROUTINE_TOOL]: tool({
			description: `Set up a routine: a job you do on a schedule without being asked, such as a 9am standup or a weekly report. Only when the person asks for one, or agrees to one you suggest. Schedules run in ${zone}. When it is set up, tell them when it runs and link its name to the settingsUrl you get back, where they can change or remove it.`,
			inputSchema: Schema.Struct({ name, instructions, schedule, results }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: (input) =>
				answer(Effect.map(routines.create(bot, input), (routine) => ({ routine }))),
		}),
		[UPDATE_ROUTINE_TOOL]: tool({
			description: `Change one of your routines, by the id list_routines gives: its name, instructions, schedule, where its result goes, or whether it is paused. Give only what changes. Schedules run in ${zone}. A webhook routine's trigger can only be changed in its settings.`,
			inputSchema: Schema.Struct({
				routineId: Schema.String.check(Schema.isUUID()).annotate({
					description: "The routine's id, from list_routines.",
				}),
				name: Schema.optional(name),
				instructions: Schema.optional(instructions),
				schedule: Schema.optional(schedule),
				results: Schema.optional(results),
				paused: Schema.optional(
					Schema.Boolean.annotate({ description: "true pauses it; false sets it running again." }),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: ({ routineId, ...changes }) =>
				answer(Effect.map(routines.update(bot, routineId, changes), (routine) => ({ routine }))),
		}),
	};
}
