import {
	type CalendarSchedule,
	MAX_EVERY_DAYS,
	MAX_EVERY_MONTHS,
	MAX_EVERY_WEEKS,
} from "@sugabots/contracts";
import { Minus, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import {
	canAddTime,
	DAY_OPTIONS,
	formatDayOfMonth,
	formatEvery,
	formatTime,
	nextTime,
	REPEAT_OPTIONS,
	type ScheduleReading,
	TIME_STEP_MINUTES,
	today,
	withRepeat,
} from "@/lib/routine-schedule.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsChoiceRow, SettingsFieldLabel, SettingsGroup } from "@/ui/settings-page.tsx";

/** The most of each unit a schedule can skip between runs. */
const MAX_EVERY = { daily: MAX_EVERY_DAYS, weekly: MAX_EVERY_WEEKS, monthly: MAX_EVERY_MONTHS };

/** The days of the month a schedule can pick: the 1st to the 28th, so each falls in every month, then the last day. */
const LAST_NUMBERED_DAY = 28;

/**
 * A schedule's groups: how often it repeats and every how many, on which
 * days, then at which times, with `note` under the last. A schedule written
 * as cron shows as written until a repeat is picked in its place.
 */
export function ScheduleGroups({
	reading,
	note,
	onChange,
}: {
	reading: ScheduleReading;
	note: string;
	onChange: (schedule: CalendarSchedule) => void;
}) {
	const schedule = reading.kind === "picked" ? reading.schedule : undefined;
	return (
		<>
			<SettingsGroup note={schedule ? undefined : note}>
				<SettingsChoiceRow
					label="Repeat"
					options={REPEAT_OPTIONS}
					value={schedule?.repeat}
					onChange={(repeat) => onChange(withRepeat(reading, repeat))}
				/>
				{reading.kind === "written" && (
					<div className="flex flex-col gap-1 border-border border-b px-4 py-3 last:border-b-0">
						<span className="text-[14.5px] text-foreground">{reading.label}</span>
						<code className="font-mono text-[13px] text-muted-foreground">
							{reading.expression}
						</code>
						<span className="text-sm text-subtle-foreground">Pick a repeat to replace it.</span>
					</div>
				)}
				{schedule && <RepeatRows schedule={schedule} onChange={onChange} />}
			</SettingsGroup>
			{schedule && (
				<SettingsGroup note={note}>
					<TimesRow times={schedule.times} onChange={(times) => onChange({ ...schedule, times })} />
				</SettingsGroup>
			)}
		</>
	);
}

/** Every how many days, weeks or months, and for a weekly or monthly schedule, on which days. */
function RepeatRows({
	schedule,
	onChange,
}: {
	schedule: CalendarSchedule;
	onChange: (schedule: CalendarSchedule) => void;
}) {
	// How often counts from today, so a change of pace starts now.
	const changeEvery = (every: number) => onChange({ ...schedule, every, startsOn: today() });
	const max = MAX_EVERY[schedule.repeat];

	return (
		<>
			<StepperRow
				label="Every"
				value={formatEvery(schedule)}
				lessLabel="Closer together"
				moreLabel="Further apart"
				onLess={schedule.every > 1 ? () => changeEvery(schedule.every - 1) : undefined}
				onMore={schedule.every < max ? () => changeEvery(schedule.every + 1) : undefined}
			/>
			{schedule.repeat === "weekly" && (
				<fieldset className="m-0 flex min-h-[46px] items-center gap-3 border-0 border-border border-b px-4 py-2.5 last:border-b-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
					<legend className="sr-only">Days</legend>
					{/* The legend names the days for assistive technology; this shows it in the label column. */}
					<span aria-hidden className="contents">
						<SettingsFieldLabel>Days</SettingsFieldLabel>
					</span>
					<span className="flex gap-1.5 sm:ml-auto max-sm:justify-between">
						{DAY_OPTIONS.map((day) => {
							const selected = schedule.days.includes(day.value);
							return (
								<label
									key={day.value}
									title={day.long}
									className="focus-ring-within grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-chip font-medium text-[13px] text-soft-foreground transition-colors has-checked:bg-primary has-checked:text-primary-foreground"
								>
									<input
										type="checkbox"
										aria-label={day.long}
										checked={selected}
										onChange={() =>
											onChange({
												...schedule,
												days: selected
													? schedule.days.filter((value) => value !== day.value)
													: [...schedule.days, day.value],
											})
										}
										className="sr-only"
									/>
									<span aria-hidden>{day.letter}</span>
								</label>
							);
						})}
					</span>
				</fieldset>
			)}
			{schedule.repeat === "monthly" && (
				<StepperRow
					label="On the"
					value={formatDayOfMonth(schedule.dayOfMonth)}
					lessLabel="A day earlier"
					moreLabel="A day later"
					onLess={() =>
						onChange({ ...schedule, dayOfMonth: stepDayOfMonth(schedule.dayOfMonth, -1) })
					}
					onMore={() =>
						onChange({ ...schedule, dayOfMonth: stepDayOfMonth(schedule.dayOfMonth, 1) })
					}
				/>
			)}
		</>
	);
}

/** The times a day can be picked from: each half hour. */
const PICKABLE_TIMES = Array.from(
	{ length: (24 * 60) / TIME_STEP_MINUTES },
	(_, index) => index * TIME_STEP_MINUTES,
);

/**
 * The times a schedule runs at, each a chip picked from the half hours, with
 * an × to remove it while another is left, and + Add for one more.
 */
function TimesRow({
	times,
	onChange,
}: {
	times: readonly number[];
	onChange: (times: number[]) => void;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
			<SettingsFieldLabel>Times</SettingsFieldLabel>
			<ul className="m-0 flex flex-1 list-none flex-wrap gap-2 p-0">
				{times.map((time, index) => {
					const others = times.filter((_, other) => other !== index);
					// A time read from cron can sit between the half hours; it stays pickable as it is.
					const options = PICKABLE_TIMES.includes(time)
						? PICKABLE_TIMES
						: [...PICKABLE_TIMES, time].sort((a, b) => a - b);
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: a time is its place in the list, so it keeps its chip, and its focus, as it changes to another time.
							key={index}
							className="flex items-center rounded-lg bg-chip"
						>
							<select
								aria-label={`Time ${index + 1}`}
								value={time}
								onChange={(event) =>
									onChange(
										times.map((current, other) =>
											other === index ? Number(event.target.value) : current,
										),
									)
								}
								className="focus-ring cursor-pointer appearance-none rounded-lg bg-transparent py-1.5 pr-1 pl-3 font-semibold text-[14px] text-foreground tabular-nums"
							>
								{options.map((option) => (
									<option key={option} value={option} disabled={others.includes(option)}>
										{formatTime(option)}
									</option>
								))}
							</select>
							{times.length > 1 ? (
								<IconButton label={`Remove ${formatTime(time)}`} onClick={() => onChange(others)}>
									<X />
								</IconButton>
							) : (
								<span className="w-2" />
							)}
						</li>
					);
				})}
				{canAddTime(times) && (
					<li>
						<button
							type="button"
							aria-label="Add a time"
							onClick={() => onChange([...times, nextTime(times)])}
							className="focus-ring h-full rounded-lg bg-primary px-3 py-1.5 font-medium text-[14px] text-primary-foreground transition-colors hover:bg-primary-hover"
						>
							+ Add
						</button>
					</li>
				)}
			</ul>
		</div>
	);
}

/** The 1st to the 28th, then the last day, round again either way. */
function stepDayOfMonth(day: number | "last", step: 1 | -1): number | "last" {
	const position = day === "last" ? LAST_NUMBERED_DAY + 1 : day;
	const next = ((position - 1 + step + LAST_NUMBERED_DAY + 1) % (LAST_NUMBERED_DAY + 1)) + 1;
	return next === LAST_NUMBERED_DAY + 1 ? "last" : next;
}

/** A row with a value between − and +. */
function StepperRow({
	label,
	value,
	lessLabel,
	moreLabel,
	onLess,
	onMore,
}: {
	label: string;
	value: string;
	lessLabel: string;
	moreLabel: string;
	/** Absent when the value is as low as it goes. */
	onLess: (() => void) | undefined;
	/** Absent when the value is as high as it goes. */
	onMore: (() => void) | undefined;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<SettingsFieldLabel>{label}</SettingsFieldLabel>
			<span className="flex flex-1 items-center justify-end gap-3">
				<StepButton label={lessLabel} onClick={onLess}>
					<Minus size={14} strokeWidth={2.4} />
				</StepButton>
				<output
					aria-label={label}
					className="min-w-16 text-center font-semibold text-[16px] text-foreground tabular-nums"
				>
					{value}
				</output>
				<StepButton label={moreLabel} onClick={onMore}>
					<Plus size={14} strokeWidth={2.4} />
				</StepButton>
			</span>
		</div>
	);
}

function StepButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: (() => void) | undefined;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			disabled={!onClick}
			className="focus-ring grid size-[30px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover disabled:opacity-45"
		>
			{children}
		</button>
	);
}
