import type { Weekday } from "@sugabots/contracts";
import { calendarScheduleLabel } from "@sugabots/contracts/routine-schedule-label";
import { cn } from "cn";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { cast } from "@/cast";
import { BotAvatar } from "@/components/bot-avatar";
import { DemoCard } from "@/components/demo-card";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";

const repeats = { daily: "Every day", weekdays: "Weekdays", weekly: "Weekly" } as const;
type Repeat = keyof typeof repeats;

const days = [
	["M", "Mondays", "mon"],
	["Tu", "Tuesdays", "tue"],
	["W", "Wednesdays", "wed"],
	["Th", "Thursdays", "thu"],
	["F", "Fridays", "fri"],
	["Sa", "Saturdays", "sat"],
	["Su", "Sundays", "sun"],
] as const satisfies readonly (readonly [string, string, Weekday])[];

const WORKING_DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
/** Any date will do: the demo's routines repeat every day or week from it. */
const STARTS_ON = "2026-01-05";

const HOURS_IN_DAY = 24;

const ROW_LABEL = "w-16 text-sm font-semibold";

/** How the app words a routine, e.g. "Weekdays at 8:00". */
function describeRoutine(repeat: Repeat, pickedDays: readonly number[], hour: number) {
	const times = [hour * 60];
	if (repeat === "daily") {
		return calendarScheduleLabel({ repeat: "daily", every: 1, times, startsOn: STARTS_ON });
	}
	const weekly = (weekdays: Weekday[]) =>
		calendarScheduleLabel({
			repeat: "weekly",
			every: 1,
			days: weekdays,
			times,
			startsOn: STARTS_ON,
		});
	if (repeat === "weekdays") return weekly(WORKING_DAYS);
	if (pickedDays.length === 0) return "Pick at least one day";
	return weekly(pickedDays.flatMap((day) => days[day]?.[2] ?? []));
}

/** A routine's settings to play with, and the summary the app shows for them. */
export function RoutineBuilder() {
	const [repeat, setRepeat] = useState<Repeat>("weekdays");
	const [pickedDays, setPickedDays] = useState<readonly number[]>([0, 3]);
	const [hour, setHour] = useState(8);
	const bot = cast.inboxSorter;

	function toggleDay(day: number) {
		setPickedDays((current) =>
			current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
		);
	}

	return (
		<DemoCard>
			<div className="flex flex-col gap-4 border-b px-5 py-4">
				<ChoiceChips
					label="Repeat"
					labelClassName={cn("float-left", ROW_LABEL)}
					options={repeats}
					value={repeat}
					onChange={setRepeat}
				/>
				{repeat === "weekly" && (
					<div className="flex flex-wrap items-center gap-1.5">
						<span className={ROW_LABEL}>Days</span>
						{days.map(([short, long], day) => (
							<button
								key={long}
								type="button"
								aria-label={long}
								aria-pressed={pickedDays.includes(day)}
								onClick={() => toggleDay(day)}
								className={cn(
									"size-8 rounded-full text-xs font-bold transition-colors",
									pickedDays.includes(day)
										? "bg-brand text-brand-foreground"
										: "bg-muted text-muted-foreground",
								)}
							>
								{short}
							</button>
						))}
					</div>
				)}
				<div className="flex items-center gap-2">
					<span className={ROW_LABEL}>Time</span>
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="Earlier"
						onClick={() => setHour((h) => (h + HOURS_IN_DAY - 1) % HOURS_IN_DAY)}
					>
						<MinusIcon />
					</Button>
					<span className="w-14 text-center font-mono font-semibold">{hour}:00</span>
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="Later"
						onClick={() => setHour((h) => (h + 1) % HOURS_IN_DAY)}
					>
						<PlusIcon />
					</Button>
				</div>
			</div>
			<div className="flex items-center gap-3 px-5 py-4">
				<BotAvatar size="lg" {...bot.avatar} />
				<div className="flex flex-col">
					<span className="font-bold">Morning inbox sweep</span>
					<span className="text-sm text-muted-foreground">
						{bot.name}
						<span className="ms-3">{describeRoutine(repeat, pickedDays, hour)}</span>
					</span>
				</div>
			</div>
		</DemoCard>
	);
}
