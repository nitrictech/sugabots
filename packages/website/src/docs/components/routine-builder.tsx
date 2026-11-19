import { cn } from "cn";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { cast } from "@/cast";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";

const repeats = { daily: "Every day", weekdays: "Weekdays", weekly: "Weekly" } as const;
type Repeat = keyof typeof repeats;

const days = [
	["M", "Mondays"],
	["Tu", "Tuesdays"],
	["W", "Wednesdays"],
	["Th", "Thursdays"],
	["F", "Fridays"],
	["Sa", "Saturdays"],
	["Su", "Sundays"],
] as const;

const HOURS_IN_DAY = 24;

const ROW_LABEL = "w-16 text-sm font-semibold";

function listInEnglish(items: readonly string[]) {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** How the app words a routine, e.g. "Weekdays at 8:00". */
function describeRoutine(repeat: Repeat, pickedDays: readonly number[], hour: number) {
	const time = `${hour}:00`;
	if (repeat === "daily") return `Every day at ${time}`;
	if (repeat === "weekdays") return `Weekdays at ${time}`;
	if (pickedDays.length === 0) return "Pick at least one day";
	const names = pickedDays.map((day) => days[day]?.[1] ?? "");
	return `${listInEnglish(names)} at ${time}`;
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
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
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
				<BotAvatar size="lg" {...bot.look} />
				<div className="flex flex-col">
					<span className="font-bold">Morning inbox sweep</span>
					<span className="text-sm text-muted-foreground">
						{bot.name} · {describeRoutine(repeat, pickedDays, hour)}
					</span>
				</div>
			</div>
		</Card>
	);
}
