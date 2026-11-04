import type {
	CalendarSchedule,
	MessagePart,
	RoutineTriggerInput,
	ToolCallPart,
} from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import listTimeCases from "../../../contracts/cases/list-time.cases.json" with { type: "json" };
import nameListCases from "../../../contracts/cases/name-list.cases.json" with { type: "json" };
import routineScheduleCases from "../../../contracts/cases/routine-schedule.cases.json" with {
	type: "json",
};
import toolNameCases from "../../../contracts/cases/tool-names.cases.json" with { type: "json" };
import toolStepCases from "../../../contracts/cases/tool-steps.cases.json" with { type: "json" };
import { durationOf, formatDuration, formatTotal } from "../screens/tool-activity.ts";
import {
	describeStep,
	noteOf,
	outputValue,
	stepDetails,
	toolLineText,
	toolStepRuns,
} from "../screens/tool-steps.ts";
import type { ConnectionLook } from "./connections.ts";
import {
	formatAge,
	formatClockTime,
	formatListTime,
	formatListTimeInSentence,
} from "./list-time.ts";
import { countOf, listNames } from "./name-list.ts";
import {
	formatDayOfMonth,
	formatEvery,
	formatTime,
	nextTime,
	scheduleSummary,
	stepTime,
	triggerLabel,
} from "./routine-schedule.ts";
import { connectionLabel, stepLabel, toolTitle, wordsFromKey } from "./tool-names.ts";

/*
 * The rules in `packages/contracts/cases/*.cases.json` are copied into the
 * phone apps, which run the same cases against their own copies (the iOS app's
 * `apps/ios/scripts/check-rules.sh`). Change a case here when the web's
 * behaviour changes, and an app's check fails until its copy does the same.
 *
 * Each file maps a rule's name to its cases: the arguments it is `given`, as
 * JSON, and what it returns for them, with null for nothing. A key starting
 * with `//` is a note to the file's readers, such as where an app knowingly
 * differs, and no rule.
 */

type Rule = (...given: never[]) => unknown;
type Case = { given: readonly unknown[]; expect: unknown };
type Cases = Record<string, unknown>;

const NOTE_PREFIX = "//";

/** The file's rules and their cases, without its notes. */
function rulesIn(cases: Cases): [string, Case[]][] {
	return Object.entries(cases).filter(([name]) => !name.startsWith(NOTE_PREFIX)) as [
		string,
		Case[],
	][];
}

const suites: { file: string; cases: Cases; rules: Record<string, Rule> }[] = [
	{
		file: "tool-names.cases.json",
		cases: toolNameCases,
		rules: { stepLabel, toolTitle, connectionLabel, wordsFromKey },
	},
	{
		// Times are written as local date-times, with no offset, so both sides read them in their own time zone.
		// Month and weekday names come from each platform's own locale data, which can differ
		// (en-AU's September is "Sept" in Node and "Sep" on Apple's); a case where they differ is left out.
		file: "list-time.cases.json",
		cases: listTimeCases,
		rules: {
			formatClockTime: (at: string, locale: string) => formatClockTime(new Date(at), locale),
			formatListTime: (at: string, now: string, locale: string) =>
				formatListTime(new Date(at), new Date(now), locale),
			formatListTimeInSentence: (at: string, now: string, locale: string) =>
				formatListTimeInSentence(new Date(at), new Date(now), locale),
			formatAge: (at: string, now: string, locale: string) =>
				formatAge(new Date(at), new Date(now), locale),
		},
	},
	{ file: "name-list.cases.json", cases: nameListCases, rules: { listNames, countOf } },
	{
		// Calls are as the API sends them. Runs list their calls by id; file names and connections' looks are by id and handle.
		file: "tool-steps.cases.json",
		cases: toolStepCases,
		rules: {
			toolStepRuns: (parts: MessagePart[]) =>
				toolStepRuns(parts).map(({ narration, calls }) => ({
					narration,
					calls: calls.map(({ id }) => id),
				})),
			describeStep: (call: ToolCallPart, fileNames: Record<string, string>) =>
				describeStep(call, new Map(Object.entries(fileNames))),
			stepDetails,
			outputValue,
			noteOf,
			toolLineText: (calls: ToolCallPart[], looks: Record<string, ConnectionLook>) =>
				toolLineText(calls, new Map(Object.entries(looks))),
			durationOf,
			formatDuration,
			formatTotal,
		},
	},
	{
		file: "routine-schedule.cases.json",
		cases: routineScheduleCases,
		rules: {
			formatTime,
			formatDayOfMonth,
			stepTime,
			nextTime,
			formatEvery: (schedule: CalendarSchedule) => formatEvery(schedule),
			scheduleSummary: (schedule: CalendarSchedule) => scheduleSummary(schedule),
			triggerLabel: (trigger: RoutineTriggerInput) => triggerLabel(trigger),
		},
	},
];

it("runs every case file", () => {
	const files = Object.keys(import.meta.glob("../../../contracts/cases/*.cases.json"));
	const names = files.map((path) => path.slice(path.lastIndexOf("/") + 1));
	expect(names.sort()).toEqual(suites.map(({ file }) => file).sort());
});

for (const { file, cases, rules } of suites) {
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
				expect((rules[name] as Rule)(...(given as never[])) ?? null).toEqual(expected);
			});
		}
	});
}
