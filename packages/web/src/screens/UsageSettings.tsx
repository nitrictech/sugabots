import { botPalettes } from "@sugabots/avatars";
import {
	type BotColor,
	type BotEyes,
	type BotShape,
	providerBuiltIn,
	type UsageMonth,
	type WorkspaceUsage,
} from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { modelName } from "@/lib/model-providers.ts";
import { countOf } from "@/lib/name-list.ts";
import { projectPalettes } from "@/lib/project-looks.ts";
import { PROVIDER_HUES } from "@/lib/provider-hues.ts";
import {
	dateIn,
	dayLabel,
	formatUsd,
	longMonthLabel,
	monthIn,
	monthLabel,
	shiftMonth,
	timeZoneOrUtc,
	useWorkspaceUsage,
} from "@/lib/usage.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { LetterTile } from "@/ui/letter-tile.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { SETTINGS_CARD, SettingsGroup, SettingsPage } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ProviderTile } from "./ProviderSettings.tsx";

/**
 * What the workspace's models cost, a month at a time: the total and each
 * day's cost, then the month broken down by bot or by model. Amounts
 * are estimates from each provider's published prices; a request that could
 * not be priced is counted, not guessed at.
 */
export function UsageSettings({
	now = new Date(),
}: {
	/** What decides this month and today, in the workspace's time zone. */
	now?: Date;
}) {
	const workspaceTimeZone = useWorkspace().workspace?.timeZone;
	const timeZone = workspaceTimeZone && timeZoneOrUtc(workspaceTimeZone);
	const thisMonth = timeZone && monthIn(now, timeZone);
	// Unset until a month is stepped to, so this month follows the workspace once it has loaded.
	const [steppedTo, setMonth] = useState<UsageMonth>();
	const month = steppedTo ?? thisMonth;
	const usage = useWorkspaceUsage(month);

	return (
		<SettingsPage title="Usage" description="What bots have cost so far this month.">
			{usage.error ? (
				<Alert>{failureMessage(usage.error)}</Alert>
			) : usage.data && timeZone ? (
				<>
					<UsageSummary
						usage={usage.data}
						today={dateIn(now, timeZone)}
						stale={usage.isPlaceholderData}
						stepper={
							month &&
							thisMonth && <MonthStepper month={month} latest={thisMonth} onChange={setMonth} />
						}
					/>
					<Breakdown usage={usage.data} stale={usage.isPlaceholderData} />
				</>
			) : (
				<div aria-hidden className={cn(SETTINGS_CARD, "h-56 animate-pulse")} />
			)}
		</SettingsPage>
	);
}

function MonthStepper({
	month,
	latest,
	onChange,
}: {
	month: UsageMonth;
	/** The month that is still going, past which there is nothing to show. */
	latest: UsageMonth;
	onChange: (month: UsageMonth) => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<IconButton label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>
				<ChevronLeft strokeWidth={2} />
			</IconButton>
			<span className="min-w-20 text-center font-medium text-xs text-foreground">
				{monthLabel(month)}
			</span>
			<IconButton
				label="Next month"
				disabled={month >= latest}
				onClick={() => onChange(shiftMonth(month, 1))}
			>
				<ChevronRight strokeWidth={2} />
			</IconButton>
		</div>
	);
}

/** The month's total beside the way to another month, and a bar for each of its days. */
function UsageSummary({
	usage,
	today,
	stale,
	stepper,
}: {
	usage: WorkspaceUsage;
	today: string;
	/** Whether this is the month before the one stepped to, shown while that one loads. */
	stale: boolean;
	stepper: ReactNode;
}) {
	const first = usage.days[0];
	const last = usage.days.at(-1);
	return (
		<section
			aria-label={`Usage in ${longMonthLabel(usage.month)}`}
			aria-busy={stale}
			className={cn(SETTINGS_CARD, "-mt-2 flex flex-col gap-5 p-5")}
		>
			<div className="flex items-center gap-3">
				<p
					className={cn(
						"m-0 flex-1 font-semibold text-3xl text-foreground tabular-nums tracking-tight",
						staleness(stale),
					)}
				>
					{formatUsd(usage.usd)}
				</p>
				{stepper}
			</div>
			<div className={cn("flex flex-col gap-2", staleness(stale))}>
				<DailySpend days={usage.days} today={today} />
				{first && last && (
					<div aria-hidden className="flex justify-between text-subtle-foreground text-xs">
						<span>{dayLabel(first.date)}</span>
						<span>{dayLabel(last.date)}</span>
					</div>
				)}
			</div>
		</section>
	);
}

/** Fades figures that are still the last month's while the next one loads, rather than blanking them. */
function staleness(stale: boolean): string {
	return cn("transition-opacity duration-150", stale && "opacity-40");
}

type UsageDay = WorkspaceUsage["days"][number];

/**
 * A bar for each day. Hovering or tapping a day so far shows what it cost;
 * days still to come are an empty mark.
 */
function DailySpend({ days, today }: { days: readonly UsageDay[]; today: string }) {
	const [openDate, setOpenDate] = useState<string>();
	const busiest = days.reduce(
		(most, day) => (day.usd > most.usd ? day : most),
		days[0] ?? { date: "", usd: 0 },
	);

	return (
		// biome-ignore lint/a11y/useSemanticElements: this group labels a chart of buttons, not form controls, so a fieldset is inappropriate.
		<div
			role="group"
			aria-label={
				busiest.usd > 0
					? `Spend each day. The most was ${formatUsd(busiest.usd)}, on ${dayLabel(busiest.date)}.`
					: "Spend each day. Nothing was spent."
			}
			className="-mx-0.5 flex h-24 items-end"
		>
			{days.map((day) =>
				day.date > today ? (
					<span key={day.date} className="flex h-full min-w-0 flex-1 items-end px-0.5">
						<span className="h-0.5 w-full rounded bg-chip" />
					</span>
				) : (
					<Tooltip
						key={day.date}
						side="top"
						delay={0}
						closeOnClick={false}
						open={openDate === day.date}
						onOpenChange={(open) =>
							// Moving between bars opens the next before closing the last, so only close this day's.
							setOpenDate((current) =>
								open ? day.date : current === day.date ? undefined : current,
							)
						}
						label={
							<span className="flex flex-col items-center">
								<span className="font-semibold tabular-nums">{formatUsd(day.usd)}</span>
								<span className="text-background/70">{dayLabel(day.date)}</span>
							</span>
						}
					>
						<button
							type="button"
							// Touch never hovers, so a tap opens the tooltip instead.
							onClick={() => setOpenDate(day.date)}
							tabIndex={-1}
							aria-label={`${dayLabel(day.date)}: ${formatUsd(day.usd)}`}
							className="group flex h-full min-w-0 flex-1 cursor-default px-0.5"
						>
							<span className="flex w-full items-end rounded group-data-popup-open:bg-chip">
								<span
									className={cn(
										"min-h-0.5 w-full rounded",
										day.date === today ? "bg-usage-bar-today" : "bg-usage-bar",
									)}
									style={
										busiest.usd === 0 ? undefined : { height: `${(day.usd / busiest.usd) * 100}%` }
									}
								/>
							</span>
						</button>
					</Tooltip>
				),
			)}
		</div>
	);
}

type BreakdownView = "bot" | "model";

const breakdownViews: readonly { value: BreakdownView; label: string }[] = [
	{ value: "bot", label: "Bot" },
	{ value: "model", label: "Model" },
];

/** One line of a breakdown: what the cost was for, and how much. */
interface Line {
	key: string;
	icon: ReactNode;
	label: string;
	sub?: string;
	/** The bar's colour, as a CSS colour. */
	color: string;
	usd: number;
	unknownCostRequests: number;
}

const SYSTEM_BOTS_WORK = "Compaction, model tests";

const PERSONAL_ASSISTANTS_WORK = "Everyone's, together";

/** A bar for what isn't one bot's, drawn in the neutral grey the design gives it. */
const NEUTRAL_BAR = "var(--subtle-foreground)";

function Breakdown({ usage, stale }: { usage: WorkspaceUsage; stale: boolean }) {
	const [view, setView] = useState<BreakdownView>("bot");
	const lines = linesFor(view, usage);
	const largest = Math.max(0, ...lines.map((line) => line.usd));
	return (
		<SettingsGroup
			label="Breakdown"
			action={
				<RadioGroup aria-label="Break the month down by" value={view} onValueChange={setView}>
					{breakdownViews.map((option) => (
						<RadioGroupItem key={option.value} value={option.value}>
							{option.label}
						</RadioGroupItem>
					))}
				</RadioGroup>
			}
			note={footnote(usage.unknownCostRequests)}
		>
			{lines.length === 0 ? (
				<p
					className={cn(
						"m-0 px-4 py-6 text-center text-xs text-muted-foreground",
						staleness(stale),
					)}
				>
					Nothing was spent in {longMonthLabel(usage.month)}.
				</p>
			) : (
				<ul aria-busy={stale} className={cn("m-0 list-none p-0", staleness(stale))}>
					{lines.map((line) => (
						<BreakdownLine key={line.key} line={line} largest={largest} />
					))}
				</ul>
			)}
		</SettingsGroup>
	);
}

function BreakdownLine({ line, largest }: { line: Line; largest: number }) {
	const unknown = line.usd === 0 && line.unknownCostRequests > 0;
	return (
		<li className="flex min-h-14 min-w-0 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0 sm:gap-5">
			<span className="flex min-w-0 flex-wide basis-0 items-center gap-3 sm:flex-1">
				<span aria-hidden className="shrink-0">
					{line.icon}
				</span>
				<span className="flex min-w-0 flex-col leading-snug">
					<span title={line.label} className="truncate text-sm text-foreground">
						{line.label}
					</span>
					<span className="truncate text-subtle-foreground text-xs">{line.sub}</span>
				</span>
			</span>
			<span aria-hidden className="h-1 min-w-10 flex-1 basis-0 rounded-full bg-chip-strong">
				<span
					className="block h-full rounded-full"
					style={{
						width: `${largest > 0 ? (line.usd / largest) * 100 : 0}%`,
						background: line.color,
					}}
				/>
			</span>
			<span className="w-20 shrink-0 text-right text-xs text-foreground tabular-nums">
				{unknown ? (
					<>
						<span aria-hidden>—</span>
						<span className="sr-only">Not priced</span>
					</>
				) : (
					formatUsd(line.usd)
				)}
			</span>
		</li>
	);
}

type ModelUsage = WorkspaceUsage["models"][number];

/**
 * A colour for each provider, by the order its first model comes in the
 * breakdown, which is by cost: the provider that cost most gets the first.
 * Every model through one provider shares its colour; past eight they repeat.
 */
function providerColors(models: readonly ModelUsage[]): (model: ModelUsage) => string {
	const providerOf = (model: ModelUsage) => model.builtIn ?? model.providerName ?? "removed";
	const order = [...new Set(models.map(providerOf))];
	return (model) => {
		const hue = PROVIDER_HUES[order.indexOf(providerOf(model)) % PROVIDER_HUES.length] ?? "blue";
		return projectPalettes[hue].swatch;
	};
}

function linesFor(view: BreakdownView, usage: WorkspaceUsage): Line[] {
	const spent = (line: Line) => line.usd > 0 || line.unknownCostRequests > 0;
	// Each is its own member's, so they are shown together, never one by one.
	const personalAssistants: Line = {
		key: "personal-assistants",
		icon: <FacelessTile name="Personal Assistants" />,
		label: "Personal Assistants",
		sub: PERSONAL_ASSISTANTS_WORK,
		color: NEUTRAL_BAR,
		...usage.personalAssistants,
	};
	const systemBots: Line = {
		key: "system-bots",
		icon: <FacelessTile name="System bots" />,
		label: "System bots",
		sub: SYSTEM_BOTS_WORK,
		color: NEUTRAL_BAR,
		...usage.systemBots,
	};
	const withSystemBots = (lines: Line[]) => [
		...lines,
		...[personalAssistants, systemBots].filter(spent),
	];

	switch (view) {
		case "bot":
			return withSystemBots(
				usage.bots.map((bot) => ({
					key: bot.botId,
					icon: <BotIcon color={bot.color} eyes={bot.eyes} shape={bot.shape} name={bot.name} />,
					label: bot.name ?? "Deleted bot",
					color: bot.color ? botPalettes[bot.color].face : NEUTRAL_BAR,
					usd: bot.usd,
					unknownCostRequests: bot.unknownCostRequests,
				})),
			);
		case "model": {
			const colorOf = providerColors(usage.models);
			return usage.models.map((model) => {
				const label = modelName({ displayName: model.displayName, modelId: model.model });
				const providerName =
					model.providerName ??
					(model.builtIn ? providerBuiltIn(model.builtIn).name : "Removed provider");
				return {
					key: `${model.model}:${model.providerName}`,
					icon: <ProviderTile name={providerName} builtIn={model.builtIn} />,
					label,
					sub: providerName,
					color: colorOf(model),
					usd: model.usd,
					unknownCostRequests: model.unknownCostRequests,
				};
			});
		}
	}
}

function BotIcon({
	color,
	eyes,
	shape,
	name,
}: {
	color: BotColor | null;
	eyes: BotEyes | null;
	shape: BotShape | null;
	name: string | null;
}) {
	return color ? (
		<BotAvatar color={color} eyes={eyes ?? undefined} shape={shape ?? "circle"} size={24} />
	) : (
		<FacelessTile name={name ?? "Deleted bot"} />
	);
}

/** A letter tile as small as the bots' faces beside it, for a line with no face of its own. */
function FacelessTile({ name }: { name: string }) {
	return (
		<LetterTile name={name} className="size-6 border-0 bg-chip text-2xs text-muted-foreground" />
	);
}

function footnote(unknownCostRequests: number): string {
	const unknownCost =
		unknownCostRequests === 0
			? ""
			: ` ${countOf(unknownCostRequests, "request", "requests")} ${unknownCostRequests === 1 ? "has" : "have"} an unknown cost and ${unknownCostRequests === 1 ? "isn't" : "aren't"} included.`;
	return `Estimated from each provider's published prices.${unknownCost} Your provider bills you directly.`;
}
