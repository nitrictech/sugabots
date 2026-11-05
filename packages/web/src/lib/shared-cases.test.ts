import {
	canStartMention,
	mentionedHandles,
	messagePartSchema,
	messagePreview,
	messageSchema,
	personParticipantSchema,
	quotedPreview,
	type Routine,
	type RoutineSchedule,
	type RoutineTrigger,
	routineScheduleSchema,
	routineTriggerInputSchema,
	splitAroundMentions,
	type ToolCallPart,
	threadParticipantSchema,
	threadTypeSchema,
	toolCallPartSchema,
} from "@sugabots/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	firstBotNamed,
	groupMentionsBy,
	type MentionTarget,
	mentionTargetKey,
	targetWithHandle,
} from "../screens/mentions.tsx";
import { scheduleNote } from "../screens/RoutineTriggers.tsx";
import {
	findAnsweringFace,
	formatDay,
	isTyping,
	segmentsOf,
	showsNothingYet,
	startsGroup,
	startsNewDay,
} from "../screens/thread-layout.ts";
import { durationOf, formatDuration, formatTotal } from "../screens/tool-activity.ts";
import {
	describeStep,
	noteOf,
	outputValue,
	stepDetails,
	toolLineText,
	toolStepRuns,
} from "../screens/tool-steps.ts";
import { markdownOutline } from "../test-markdown-outline.ts";
import { gravatarUrl, initials } from "../ui/avatar.tsx";
import type { ConnectionLook } from "./connections.ts";
import { extensionOf, fileLookOf, fileSizeLabel } from "./file-looks.ts";
import {
	formatAge,
	formatClockTime,
	formatListTime,
	formatListTimeInSentence,
} from "./list-time.ts";
import { countOf, listNames } from "./name-list.ts";
import { formatUntil, MUTE_DURATIONS } from "./notifications.ts";
import {
	defaultSchedule,
	formatDayOfMonth,
	formatEvery,
	formatTime,
	nextRunAt,
	nextTime,
	type Repeat,
	readingLabel,
	readSchedule,
	type ScheduleReading,
	scheduleSummary,
	stepTime,
	triggerLabel,
	withRepeat,
} from "./routine-schedule.ts";
import { timeZonePlace, timeZoneRegions, utcOffset } from "./time-zones.ts";
import { connectionLabel, stepLabel, toolTitle, wordsFromKey } from "./tool-names.ts";

/*
 * The rules in `@sugabots/contracts/cases/*.cases.json` are copied into the
 * phone apps, which run the same cases against their own copies (the iOS app's
 * `apps/ios/check-rules.sh`). Change a case here when the web's
 * behaviour changes, and an app's check fails until its copy does the same.
 *
 * Each file maps a rule's name to its cases: the arguments it is `given`, as
 * JSON, and what it returns for them, with null for nothing. A key starting
 * with `//` is a note to the file's readers, such as how a case writes what a
 * rule takes or gives, or where an app knowingly differs, and no rule.
 */

type Case = { given: readonly unknown[]; expect: unknown };
type Cases = Record<string, unknown>;

/** A schema an argument is decoded with, or null for an argument the API has no schema for. */
type ArgumentSchema = Schema.Decoder<unknown> | null;

/** What `schemas` decode their arguments to: each schema's type, or `never` for null, leaving the rule to say what it takes there. */
type Decoded<Schemas extends readonly ArgumentSchema[]> = {
	[Index in keyof Schemas]: Schemas[Index] extends Schema.Decoder<infer Type> ? Type : never;
};

/**
 * A rule, called with its case's `given` arguments once each is decoded with
 * the schema in the same place of `argumentSchemas`, so a case can't give
 * something the API never sends.
 */
type Rule = {
	argumentSchemas: readonly ArgumentSchema[];
	run: (...given: never[]) => unknown;
};

const NOTE_PREFIX = "//";

/** A rule whose arguments are decoded with `argumentSchemas` before `run` is called with them. */
function decoding<const Schemas extends readonly ArgumentSchema[]>(
	argumentSchemas: Schemas,
	run: (...given: Decoded<Schemas>) => unknown,
): Rule {
	return { argumentSchemas, run: run as Rule["run"] };
}

/** `run` as a rule whose arguments are plain JSON values, with no schema to decode them with. */
function plain(run: (...given: never[]) => unknown): Rule {
	return { argumentSchemas: [], run };
}

/** A date as a local date-time with no offset, `2026-09-25T06:12`, as the cases write one. */
function localTimeText(date: Date): string {
	const twoDigits = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** `schedule`, which a case must give picked by its parts, since the rules have no words for cron. */
function calendarSchedule(schedule: RoutineSchedule) {
	if (schedule.repeat === "cron") throw new Error("A case gives a cron schedule");
	return schedule;
}

/** The file's rules and their cases, without its notes. */
function rulesIn(cases: Cases): [string, Case[]][] {
	return Object.entries(cases).filter(([name]) => !name.startsWith(NOTE_PREFIX)) as [
		string,
		Case[],
	][];
}

/** Calls `rule` with `given`, each argument decoded with its schema. */
function call(rule: Rule, given: readonly unknown[]): unknown {
	const decoded = given.map((value, index) => {
		const schema = rule.argumentSchemas[index];
		return schema ? Schema.decodeUnknownSync(schema)(value) : value;
	});
	return rule.run(...(decoded as never[]));
}

const caseFiles: Record<string, Cases> = Object.fromEntries(
	Object.entries(
		import.meta.glob<Cases>("/node_modules/@sugabots/contracts/cases/*.cases.json", {
			eager: true,
			import: "default",
		}),
	).map(([path, cases]) => [path.slice(path.lastIndexOf("/") + 1), cases]),
);

/** The web's rules each case file has cases for, by the file's name. */
const rulesByFile: Record<string, Record<string, Rule>> = {
	"tool-names.cases.json": {
		stepLabel: plain(stepLabel),
		toolTitle: plain(toolTitle),
		connectionLabel: plain(connectionLabel),
		wordsFromKey: plain(wordsFromKey),
	},
	"list-time.cases.json": {
		formatClockTime: plain((at: string, locale: string) => formatClockTime(new Date(at), locale)),
		formatListTime: plain((at: string, now: string, locale: string) =>
			formatListTime(new Date(at), new Date(now), locale),
		),
		formatListTimeInSentence: plain((at: string, now: string, locale: string) =>
			formatListTimeInSentence(new Date(at), new Date(now), locale),
		),
		formatAge: plain((at: string, now: string, locale: string) =>
			formatAge(new Date(at), new Date(now), locale),
		),
	},
	"name-list.cases.json": { listNames: plain(listNames), countOf: plain(countOf) },
	"mentions.cases.json": {
		splitAroundMentions: plain(splitAroundMentions),
		mentionedHandles: plain(mentionedHandles),
		canStartMention: plain(canStartMention),
		firstBotNamed: decoding(
			[null, Schema.Array(threadParticipantSchema)],
			(draft: string, crew) => firstBotNamed(draft, crew)?.id,
		),
		groupMentionsBy: decoding(
			[null, Schema.Array(personParticipantSchema), threadTypeSchema],
			(writer: Parameters<typeof groupMentionsBy>[0], members, threadType) =>
				groupMentionsBy(writer, members, threadType).map(({ handle, notifies }) => ({
					handle,
					notifies: notifies.map((person) => person.id),
				})),
		),
		targetWithHandle: plain((mentionable: MentionTarget[], handle: string) => {
			const target = targetWithHandle(mentionable, handle);
			return target && mentionTargetKey(target);
		}),
	},
	"thread-layout.cases.json": {
		segmentsOf: decoding([messageSchema], (message) =>
			segmentsOf(message).map((segment) =>
				segment.type === "text"
					? { type: segment.type, text: segment.text }
					: { type: segment.type },
			),
		),
		showsNothingYet: decoding([messageSchema], showsNothingYet),
		isTyping: decoding([messageSchema], isTyping),
		startsGroup: decoding([Schema.NullOr(messageSchema), messageSchema], (previous, message) =>
			startsGroup(previous ?? undefined, message),
		),
		startsNewDay: plain((previousAt: string | null, at: string) =>
			startsNewDay(previousAt ?? undefined, at),
		),
		formatDay: plain((date: string, now: string, locale: string) =>
			formatDay(new Date(date), { now: new Date(now), locale }),
		),
		findAnsweringFace: decoding([Schema.Array(messageSchema), null], findAnsweringFace),
	},
	"file-looks.cases.json": {
		fileLookOf: plain(fileLookOf),
		extensionOf: plain(extensionOf),
		fileSizeLabel: plain(fileSizeLabel),
	},
	"time-zones.cases.json": {
		timeZonePlace: plain(timeZonePlace),
		utcOffset: plain((zone: string, now: string) => utcOffset(zone, new Date(now))),
		timeZoneRegions: plain((zones: string[]) =>
			timeZoneRegions(zones.map((zone) => ({ zone, place: timeZonePlace(zone), offset: "" }))).map(
				({ name, choices }) => ({ name, zones: choices.map(({ zone }) => zone) }),
			),
		),
	},
	"avatar.cases.json": { initials: plain(initials), gravatarUrl: plain(gravatarUrl) },
	"mute.cases.json": {
		formatUntil: plain((until: string, now: string, locale: string) =>
			formatUntil(new Date(until), { now: new Date(now), locale }),
		),
		muteUntil: plain((label: string, now: string) => {
			const duration = MUTE_DURATIONS.find((one) => one.label === label);
			return duration && localTimeText(duration.until(new Date(now)));
		}),
	},
	// What MessageMarkdown draws, as test-markdown-outline.ts reads it from the page.
	"markdown.cases.json": { markdownOutline: plain(markdownOutline) },
	"message-preview.cases.json": {
		messagePreview: plain(messagePreview),
		quotedPreview: plain(quotedPreview),
	},
	"tool-steps.cases.json": {
		toolStepRuns: decoding([Schema.Array(messagePartSchema)], (parts) =>
			toolStepRuns(parts).map(({ narration, calls }) => ({
				narration,
				calls: calls.map(({ id }) => id),
			})),
		),
		describeStep: decoding([toolCallPartSchema, null], (call, fileNames: Record<string, string>) =>
			describeStep(call, new Map(Object.entries(fileNames))),
		),
		stepDetails: decoding([toolCallPartSchema], stepDetails),
		outputValue: plain(outputValue),
		noteOf: decoding([toolCallPartSchema], noteOf),
		toolLineText: decoding(
			[Schema.Array(toolCallPartSchema), null],
			(calls: readonly ToolCallPart[], looks: Record<string, ConnectionLook>) =>
				toolLineText(calls, new Map(Object.entries(looks))),
		),
		durationOf: decoding([toolCallPartSchema], durationOf),
		formatDuration: plain(formatDuration),
		formatTotal: plain(formatTotal),
	},
	"routine-schedule.cases.json": {
		formatTime: plain(formatTime),
		formatDayOfMonth: plain(formatDayOfMonth),
		stepTime: plain(stepTime),
		nextTime: plain(nextTime),
		formatEvery: decoding([routineScheduleSchema], (schedule) =>
			formatEvery(calendarSchedule(schedule)),
		),
		scheduleSummary: decoding([routineScheduleSchema], (schedule) =>
			scheduleSummary(calendarSchedule(schedule)),
		),
		triggerLabel: decoding([routineTriggerInputSchema], triggerLabel),
		// The local date-time each is given is the clock's time while it runs.
		readSchedule: plain((schedule: RoutineSchedule, now: string) =>
			atTime(now, () => readSchedule(schedule)),
		),
		readingLabel: plain(readingLabel),
		withRepeat: plain((reading: ScheduleReading, repeat: Repeat, now: string) =>
			atTime(now, () => withRepeat(reading, repeat)),
		),
		defaultSchedule: plain((now: string) => atTime(now, defaultSchedule)),
		// Each trigger's next run is given as a local date-time, and sent as the instant it is here.
		nextRunAt: plain((routine: { triggers: RoutineTrigger[] }, now: string) =>
			nextRunAt(
				{
					triggers: routine.triggers.map((trigger) =>
						trigger.kind === "cron" && trigger.nextScheduledAt
							? { ...trigger, nextScheduledAt: new Date(trigger.nextScheduledAt).toISOString() }
							: trigger,
					),
				} as unknown as Routine,
				new Date(now),
			),
		),
		scheduleNote: plain(scheduleNote),
	},
};

it("has the web's rules for every case file, and no rules without one", () => {
	expect(Object.keys(rulesByFile).sort()).toEqual(Object.keys(caseFiles).sort());
});

for (const [file, cases] of Object.entries(caseFiles)) {
	const rules = rulesByFile[file] ?? {};
	describe(file, () => {
		it("covers each of its rules, and only those", () => {
			expect(
				rulesIn(cases)
					.map(([name]) => name)
					.sort(),
			).toEqual(Object.keys(rules).sort());
		});
		for (const [name, entries] of rulesIn(cases)) {
			it.each(entries)(`${name}(%j)`, ({ given, expect: expected }) => {
				const rule = rules[name];
				if (!rule) throw new Error(`No rule called ${name}`);
				expect(call(rule, given) ?? null).toEqual(expected);
			});
		}
	});
}

/** `run`'s result with the clock set to the local date-time `now`. */
function atTime<Result>(now: string, run: () => Result): Result {
	vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
	try {
		return run();
	} finally {
		vi.useRealTimers();
	}
}
