import type { CalendarSchedule, RoutineTriggerInput } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import listTimeCases from "./list-time.cases.json" with { type: "json" };
import {
	formatAge,
	formatClockTime,
	formatListTime,
	formatListTimeInSentence,
} from "./list-time.ts";
import nameListCases from "./name-list.cases.json" with { type: "json" };
import { countOf, listNames } from "./name-list.ts";
import routineScheduleCases from "./routine-schedule.cases.json" with { type: "json" };
import {
	formatDayOfMonth,
	formatEvery,
	formatTime,
	nextTime,
	scheduleSummary,
	stepTime,
	triggerLabel,
} from "./routine-schedule.ts";
import toolNameCases from "./tool-names.cases.json" with { type: "json" };
import { connectionLabel, stepLabel, toolTitle, wordsFromKey } from "./tool-names.ts";

/*
 * The rules in these `*.cases.json` files are copied into the iOS app, which
 * runs the same cases against its Swift (`apps/ios/scripts/check-rules.sh`).
 * Change a case here when the web's behaviour changes, and the app's check
 * fails until its copy does the same.
 */

type Rule = (...given: never[]) => unknown;
type Cases = Record<string, readonly { given: readonly unknown[]; expect: unknown }[]>;

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

for (const { file, cases, rules } of suites) {
	describe(file, () => {
		it("covers each of its rules, and only those", () => {
			expect(Object.keys(cases).sort()).toEqual(Object.keys(rules).sort());
		});
		for (const [name, entries] of Object.entries(cases)) {
			it.each(entries)(`${name}(%j)`, ({ given, expect: expected }) => {
				expect((rules[name] as Rule)(...(given as never[]))).toEqual(expected);
			});
		}
	});
}
