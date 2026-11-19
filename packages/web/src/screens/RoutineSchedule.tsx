import { Select } from "@base-ui/react/select";
import {
	type CalendarSchedule,
	MAX_EVERY_DAYS,
	MAX_EVERY_MONTHS,
	MAX_EVERY_WEEKS,
} from "@sugabots/contracts";
import { formatEvery, formatTime } from "@sugabots/contracts/routine-schedule-label";
import { cn } from "cn";
import { Check, Minus, Plus, X } from "lucide-react";
import {
	canAddTime,
	DAY_OPTIONS,
	formatDayOfMonth,
	nextTime,
	REPEAT_OPTIONS,
	type RoutineReading,
	TIME_STEP_MINUTES,
	today,
	withRepeat,
} from "@/lib/routine-schedule.ts";
import { Button } from "@/ui/button.tsx";
import { MENU_ITEM, MENU_POPUP } from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	SettingsChoiceRow,
	SettingsControlRow,
	SettingsGroup,
	SettingsRow,
} from "@/ui/settings-page.tsx";

/** The most of each unit a routine can skip between runs. */
const MAX_EVERY = { daily: MAX_EVERY_DAYS, weekly: MAX_EVERY_WEEKS, monthly: MAX_EVERY_MONTHS };

/** The days of the month a routine can pick: the 1st to the 28th, so each falls in every month, then the last day. */
const LAST_NUMBERED_DAY = 28;

/**
 * A routine's groups: how often it repeats and every how many, on which days,
 * then at which times, with `note` under the last. A routine stored as cron
 * shows as written until a repeat is picked in its place.
 */
export function RoutineGroups({
	reading,
	note,
	onChange,
}: {
	reading: RoutineReading;
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
					<SettingsRow
						label={reading.label}
						sub={
							<>
								<code className="block font-mono text-muted-foreground">{reading.expression}</code>
								Pick a repeat to replace it.
							</>
						}
					/>
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

/** Every how many days, weeks or months, and for a weekly or monthly routine, on which days. */
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
				<SettingsControlRow label="Days" stackOnPhone>
					<fieldset className="m-0 flex min-w-0 gap-1.5 border-0 p-0 sm:ml-auto max-sm:justify-between">
						<legend className="sr-only">Days</legend>
						{DAY_OPTIONS.map((day) => {
							const selected = schedule.days.includes(day.value);
							return (
								<label
									key={day.value}
									title={day.long}
									className="focus-ring-within grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-chip font-medium text-xs text-soft-foreground transition-colors has-checked:bg-primary has-checked:text-primary-foreground"
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
				</SettingsControlRow>
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
 * The times a routine runs at, each a chip picked from the half hours, with
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
		<SettingsControlRow label="Times" stackOnPhone>
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
							<TimeSelect
								label={`Time ${index + 1}`}
								value={time}
								options={options}
								taken={others}
								onChange={(picked) =>
									onChange(times.map((current, other) => (other === index ? picked : current)))
								}
							/>
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
						<Button
							size="sm"
							aria-label="Add a time"
							onClick={() => onChange([...times, nextTime(times)])}
							className="h-full rounded-lg"
						>
							+ Add
						</Button>
					</li>
				)}
			</ul>
		</SettingsControlRow>
	);
}

/**
 * A time chip's picker. Its list opens below the chip and scrolls within a
 * few rows' height, rather than filling the screen with every half hour as
 * the system's own select does.
 */
function TimeSelect({
	label,
	value,
	options,
	taken,
	onChange,
}: {
	label: string;
	value: number;
	options: readonly number[];
	/** Times the routine's other chips hold, shown but not pickable. */
	taken: readonly number[];
	onChange: (time: number) => void;
}) {
	return (
		<Select.Root
			value={value}
			itemToStringLabel={formatTime}
			onValueChange={(picked) => {
				if (picked !== null) onChange(picked);
			}}
		>
			<Select.Trigger
				aria-label={label}
				className="focus-ring cursor-pointer rounded-lg py-1.5 pr-1 pl-3 font-semibold text-sm text-foreground tabular-nums"
			>
				<Select.Value />
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					className="isolate z-50 outline-none"
					alignItemWithTrigger={false}
					align="start"
					sideOffset={6}
				>
					<Select.Popup
						className={cn(
							MENU_POPUP,
							"max-h-popover min-w-(--anchor-width) scrollbar-gutter-stable",
						)}
					>
						{options.map((option) => (
							<Select.Item
								key={option}
								value={option}
								disabled={taken.includes(option)}
								className={cn(MENU_ITEM, "min-h-8 gap-3 py-1.5 pr-2 tabular-nums")}
							>
								<Select.ItemText className="flex-1">{formatTime(option)}</Select.ItemText>
								{/* Holds the tick's room on every row, so the list is as wide with it as without. */}
								<span className="flex size-4 shrink-0 text-link">
									<Select.ItemIndicator className="flex">
										<Check aria-hidden className="size-4" />
									</Select.ItemIndicator>
								</span>
							</Select.Item>
						))}
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
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
		<SettingsControlRow label={label}>
			<span className="flex flex-1 items-center justify-end gap-3">
				<IconButton variant="round" label={lessLabel} onClick={onLess} disabled={!onLess}>
					<Minus strokeWidth={2.4} />
				</IconButton>
				<output
					aria-label={label}
					className="min-w-16 text-center font-semibold text-base text-foreground tabular-nums"
				>
					{value}
				</output>
				<IconButton variant="round" label={moreLabel} onClick={onMore} disabled={!onMore}>
					<Plus strokeWidth={2.4} />
				</IconButton>
			</span>
		</SettingsControlRow>
	);
}
