import {
	type CalendarSchedule,
	canStartMention,
	type Message,
	type MessagePart,
	mentionedHandles,
	messagePreview,
	type PersonParticipant,
	quotedPreview,
	type RoutineTriggerInput,
	splitAroundMentions,
	type ThreadParticipant,
	type ThreadType,
	type ToolCallPart,
} from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import avatarCases from "../../../contracts/cases/avatar.cases.json" with { type: "json" };
import fileLookCases from "../../../contracts/cases/file-looks.cases.json" with { type: "json" };
import listTimeCases from "../../../contracts/cases/list-time.cases.json" with { type: "json" };
import markdownCases from "../../../contracts/cases/markdown.cases.json" with { type: "json" };
import mentionCases from "../../../contracts/cases/mentions.cases.json" with { type: "json" };
import messagePreviewCases from "../../../contracts/cases/message-preview.cases.json" with {
	type: "json",
};
import muteCases from "../../../contracts/cases/mute.cases.json" with { type: "json" };
import nameListCases from "../../../contracts/cases/name-list.cases.json" with { type: "json" };
import routineScheduleCases from "../../../contracts/cases/routine-schedule.cases.json" with {
	type: "json",
};
import threadLayoutCases from "../../../contracts/cases/thread-layout.cases.json" with {
	type: "json",
};
import timeZoneCases from "../../../contracts/cases/time-zones.cases.json" with { type: "json" };
import toolNameCases from "../../../contracts/cases/tool-names.cases.json" with { type: "json" };
import toolStepCases from "../../../contracts/cases/tool-steps.cases.json" with { type: "json" };
import {
	firstBotNamed,
	groupMentionsBy,
	type MentionTarget,
	mentionTargetKey,
	targetWithHandle,
} from "../screens/mentions.tsx";
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
	formatDayOfMonth,
	formatEvery,
	formatTime,
	nextTime,
	scheduleSummary,
	stepTime,
	triggerLabel,
} from "./routine-schedule.ts";
import { timeZonePlace, timeZoneRegions, utcOffset } from "./time-zones.ts";
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

/** How many image pixels the web draws a CSS pixel of a face with, as `gravatarUrl` sizes its pictures. */
const GRAVATAR_PIXEL_RATIO = 2;

/** A date as a local date-time with no offset, `2026-09-25T06:12`, as the cases write one. */
function localTimeText(date: Date): string {
	const twoDigits = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

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
		// A bot is named by its id, and whom a mention can name by `mentionTargetKey`.
		file: "mentions.cases.json",
		cases: mentionCases,
		rules: {
			splitAroundMentions,
			mentionedHandles,
			canStartMention,
			firstBotNamed: (draft: string, crew: ThreadParticipant[]) => firstBotNamed(draft, crew)?.id,
			groupMentionsBy: (
				writer: Parameters<typeof groupMentionsBy>[0],
				members: PersonParticipant[],
				threadType: ThreadType,
			) => groupMentionsBy(writer, members, threadType).map(mentionTargetKey),
			targetWithHandle: (mentionable: MentionTarget[], handle: string) => {
				const target = targetWithHandle(mentionable, handle);
				return target && mentionTargetKey(target);
			},
		},
	},
	{
		// A segment is its type, its key and a text's words; a time with no offset is local, as in list-time's cases.
		file: "thread-layout.cases.json",
		cases: threadLayoutCases,
		rules: {
			segmentsOf: (message: Message) =>
				segmentsOf(message).map((segment) =>
					segment.type === "text"
						? { type: segment.type, key: segment.key, text: segment.text }
						: { type: segment.type, key: segment.key },
				),
			showsNothingYet,
			isTyping,
			startsGroup: (previous: Message | null, message: Message) =>
				startsGroup(previous ?? undefined, message),
			startsNewDay: (previousAt: string | null, at: string) =>
				startsNewDay(previousAt ?? undefined, at),
			formatDay: (date: string, now: string, locale: string) =>
				formatDay(new Date(date), { now: new Date(now), locale }),
			findAnsweringFace,
		},
	},
	{
		file: "file-looks.cases.json",
		cases: fileLookCases,
		rules: { fileLookOf, extensionOf, fileSizeLabel },
	},
	{
		// A region is its name and its zones' names.
		file: "time-zones.cases.json",
		cases: timeZoneCases,
		rules: {
			timeZonePlace,
			utcOffset: (zone: string, now: string) => utcOffset(zone, new Date(now)),
			timeZoneRegions: (zones: string[]) =>
				timeZoneRegions(
					zones.map((zone) => ({ zone, place: timeZonePlace(zone), offset: "" })),
				).map(({ name, choices }) => ({ name, zones: choices.map(({ zone }) => zone) })),
		},
	},
	{
		// A Gravatar's size is in image pixels, which each platform draws a face at its own density with.
		file: "avatar.cases.json",
		cases: avatarCases,
		rules: {
			initials,
			gravatarUrl: (email: string, pixels: number) =>
				gravatarUrl(email, pixels / GRAVATAR_PIXEL_RATIO),
		},
	},
	{
		// Times are local date-times, as in list-time's cases; a mute is chosen by its label.
		file: "mute.cases.json",
		cases: muteCases,
		rules: {
			formatUntil: (until: string, now: string, locale: string) =>
				formatUntil(new Date(until), { now: new Date(now), locale }),
			muteUntil: (label: string, now: string) => {
				const duration = MUTE_DURATIONS.find((one) => one.label === label);
				return duration && localTimeText(duration.until(new Date(now)));
			},
		},
	},
	{
		// What MessageMarkdown draws, as test-markdown-outline.ts reads it from the page.
		file: "markdown.cases.json",
		cases: markdownCases,
		rules: { markdownOutline },
	},
	{
		file: "message-preview.cases.json",
		cases: messagePreviewCases,
		rules: { messagePreview, quotedPreview },
	},
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
