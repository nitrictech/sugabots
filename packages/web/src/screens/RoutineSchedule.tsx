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
	stepTime,
	TIME_STEP_MINUTES,
	today,
	withRepeat,
} from "@/lib/routine-schedule.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsChoiceRow, SettingsFieldLabel } from "@/ui/settings-page.tsx";

/** The most of each unit a schedule can skip between runs. */
const MAX_EVERY = { daily: MAX_EVERY_DAYS, weekly: MAX_EVERY_WEEKS, monthly: MAX_EVERY_MONTHS };

/** The days of the month a schedule can pick: the 1st to the 28th, so each falls in every month, then the last day. */
const LAST_NUMBERED_DAY = 28;

/**
 * A schedule's rows: how often it repeats and every how many, on which days,
 * and at which times. A schedule written as cron shows as written until a
 * repeat is picked in its place.
 */
export function ScheduleRows({
	reading,
	onChange,
}: {
	reading: ScheduleReading;
	onChange: (schedule: CalendarSchedule) => void;
}) {
	const schedule = reading.kind === "picked" ? reading.schedule : undefined;
	return (
		<>
			<SettingsChoiceRow
				label="Repeat"
				options={REPEAT_OPTIONS}
				value={schedule?.repeat}
				onChange={(repeat) => onChange(withRepeat(reading, repeat))}
			/>
			{reading.kind === "written" && (
				<div className="flex flex-col gap-1 border-border border-b px-4 py-3">
					<span className="text-[14.5px] text-foreground">{reading.label}</span>
					<code className="font-mono text-[13px] text-muted-foreground">{reading.expression}</code>
					<span className="text-sm text-subtle-foreground">Pick a repeat to replace it.</span>
				</div>
			)}
			{schedule && <PickedRows schedule={schedule} onChange={onChange} />}
		</>
	);
}

function PickedRows({
	schedule,
	onChange,
}: {
	schedule: CalendarSchedule;
	onChange: (schedule: CalendarSchedule) => void;
}) {
	// What every repeat has; days and the day of the month change through their own rows.
	const change = (next: Partial<Pick<CalendarSchedule, "every" | "times" | "startsOn">>) =>
		onChange({ ...schedule, ...next });
	const max = MAX_EVERY[schedule.repeat];

	return (
		<>
			<StepperRow
				label="Every"
				value={formatEvery(schedule)}
				lessLabel="Closer together"
				moreLabel="Further apart"
				// How often counts from today, so a change of pace starts now.
				onLess={
					schedule.every > 1
						? () => change({ every: schedule.every - 1, startsOn: today() })
						: undefined
				}
				onMore={
					schedule.every < max
						? () => change({ every: schedule.every + 1, startsOn: today() })
						: undefined
				}
			/>
			{schedule.repeat === "weekly" && (
				<fieldset className="m-0 grid grid-cols-7 gap-1.5 border-0 border-border border-b px-4 py-2.5">
					<legend className="sr-only">Days</legend>
					{DAY_OPTIONS.map((day) => {
						const selected = schedule.days.includes(day.value);
						return (
							<label
								key={day.value}
								title={day.long}
								className="focus-ring-within mx-auto grid aspect-square w-full max-w-11 cursor-pointer place-items-center rounded-full bg-chip font-medium text-[13px] text-soft-foreground transition-colors has-checked:bg-primary has-checked:text-primary-foreground"
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
			{schedule.times.map((time, index) => (
				<StepperRow
					// biome-ignore lint/suspicious/noArrayIndexKey: a time is its place in the list, so it keeps its row, and its focus, as it steps onto another time.
					key={index}
					label={index === 0 ? (schedule.times.length > 1 ? "Times" : "Time") : ""}
					name="Time"
					value={formatTime(time)}
					lessLabel="30 minutes earlier"
					moreLabel="30 minutes later"
					onLess={() => change({ times: moved(schedule.times, index, -TIME_STEP_MINUTES) })}
					onMore={() => change({ times: moved(schedule.times, index, TIME_STEP_MINUTES) })}
					onRemove={
						schedule.times.length > 1
							? () => change({ times: schedule.times.filter((_, other) => other !== index) })
							: undefined
					}
				/>
			))}
			{canAddTime(schedule.times) && (
				<button
					type="button"
					onClick={() => change({ times: [...schedule.times, nextTime(schedule.times)] })}
					className="focus-ring flex min-h-[46px] w-full items-center border-border border-b py-2.5 pr-4 pl-[116px] text-left font-medium text-[14px] text-link transition-colors last:border-b-0 hover:bg-panel max-sm:pl-4"
				>
					+ Add a time
				</button>
			)}
		</>
	);
}

/**
 * The times with the one at `index` moved by `step` minutes, round the
 * clock, and on past any other time it would land on.
 */
function moved(times: readonly number[], index: number, step: number): number[] {
	const others = times.filter((_, other) => other !== index);
	let time = stepTime(times[index] ?? 0, step);
	while (others.includes(time)) time = stepTime(time, step);
	return times.map((current, other) => (other === index ? time : current));
}

/** The 1st to the 28th, then the last day, round again either way. */
function stepDayOfMonth(day: number | "last", step: 1 | -1): number | "last" {
	const position = day === "last" ? LAST_NUMBERED_DAY + 1 : day;
	const next = ((position - 1 + step + LAST_NUMBERED_DAY + 1) % (LAST_NUMBERED_DAY + 1)) + 1;
	return next === LAST_NUMBERED_DAY + 1 ? "last" : next;
}

/** A row with a value between − and +, and an × to remove it when it may go. */
function StepperRow({
	label,
	name = label,
	value,
	lessLabel,
	moreLabel,
	onLess,
	onMore,
	onRemove,
}: {
	/** Blank for a row that continues the one above, such as a second time. */
	label: string;
	/** What the value is, for assistive technology, where `label` is blank. */
	name?: string;
	value: string;
	lessLabel: string;
	moreLabel: string;
	/** Absent when the value is as low as it goes. */
	onLess: (() => void) | undefined;
	/** Absent when the value is as high as it goes. */
	onMore: (() => void) | undefined;
	onRemove?: () => void;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<SettingsFieldLabel>{label}</SettingsFieldLabel>
			<span className="flex flex-1 items-center justify-end gap-3">
				<StepButton label={lessLabel} onClick={onLess}>
					<Minus size={14} strokeWidth={2.4} />
				</StepButton>
				<output
					aria-label={name}
					className="min-w-16 text-center font-semibold text-[16px] text-foreground tabular-nums"
				>
					{value}
				</output>
				<StepButton label={moreLabel} onClick={onMore}>
					<Plus size={14} strokeWidth={2.4} />
				</StepButton>
				<span className="grid w-[30px] place-items-center">
					{onRemove && (
						<IconButton label="Remove this time" size="lg" onClick={onRemove}>
							<X />
						</IconButton>
					)}
				</span>
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
