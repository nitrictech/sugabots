import { botColors } from "@sugabots/avatars";
import {
	type AgentColor,
	type AgentFace,
	providerPreset,
	type UsageMonth,
	type WorkspaceUsage,
} from "@sugabots/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
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
import { AgentAvatar } from "@/shell/Agent.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { SettingsGroup, SettingsPage } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * What the workspace's models cost, a month at a time: the total and each
 * day's spend, then the month broken down by bot, by model or by pod. Amounts
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
		<SettingsPage
			title="Usage"
			headerAction={
				month && thisMonth && <MonthStepper month={month} latest={thisMonth} onChange={setMonth} />
			}
		>
			{usage.error ? (
				<Alert>{failureMessage(usage.error)}</Alert>
			) : usage.data && timeZone ? (
				<>
					<SpendSummary usage={usage.data} today={dateIn(now, timeZone)} />
					<Breakdown usage={usage.data} />
				</>
			) : (
				<div aria-hidden className="h-[228px] animate-pulse rounded-panel bg-list" />
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
			<IconButton label="Previous month" size="lg" onClick={() => onChange(shiftMonth(month, -1))}>
				<ChevronLeft strokeWidth={2.4} />
			</IconButton>
			<span className="min-w-[72px] text-center font-semibold text-[14px] text-foreground">
				{monthLabel(month)}
			</span>
			<IconButton
				label="Next month"
				size="lg"
				disabled={month >= latest}
				onClick={() => onChange(shiftMonth(month, 1))}
			>
				<ChevronRight strokeWidth={2.4} />
			</IconButton>
		</div>
	);
}

/** The month's total, and a bar for each of its days. */
function SpendSummary({ usage, today }: { usage: WorkspaceUsage; today: string }) {
	const first = usage.days[0];
	const last = usage.days.at(-1);
	return (
		<section
			aria-label={`Spend in ${longMonthLabel(usage.month)}`}
			className="flex flex-col gap-4 rounded-panel bg-list p-4"
		>
			<p className="m-0 font-bold text-[30px] text-foreground tabular-nums tracking-[-0.01em]">
				{formatUsd(usage.usd)}
			</p>
			<DailySpend days={usage.days} today={today} />
			{first && last && (
				<div aria-hidden className="flex justify-between text-subtle-foreground text-xs">
					<span>{dayLabel(first.date)}</span>
					<span>{dayLabel(last.date)}</span>
				</div>
			)}
		</section>
	);
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
			className="-mx-[1.5px] flex h-[78px] items-end"
		>
			{days.map((day) =>
				day.date > today ? (
					<span key={day.date} className="flex h-full min-w-0 flex-1 items-end px-[1.5px]">
						<span className="h-0.5 w-full rounded-[3px] bg-chip" />
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
							className="group flex h-full min-w-0 flex-1 cursor-default px-[1.5px]"
						>
							<span className="flex w-full items-end rounded-[3px] group-data-popup-open:bg-chip">
								<span
									className="min-h-0.5 w-full rounded-[3px] bg-primary"
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

type BreakdownView = "bot" | "model" | "pod";

const breakdownViews: readonly { value: BreakdownView; label: string }[] = [
	{ value: "bot", label: "Bot" },
	{ value: "model", label: "Model" },
	{ value: "pod", label: "Pod" },
];

/** One line of a breakdown: what the spend was for, and how much. */
interface Line {
	key: string;
	icon: ReactNode;
	label: string;
	sub: string;
	/** The bar's colour, as a CSS colour. */
	color: string;
	usd: number;
	unpricedRequests: number;
}

const SYSTEM_AGENTS_WORK = "Summaries, titles, routing, compaction, model tests";

/** A bar for what isn't one bot's or pod's, drawn in the neutral grey the design gives it. */
const NEUTRAL_BAR = "var(--subtle-foreground)";

function Breakdown({ usage }: { usage: WorkspaceUsage }) {
	const [view, setView] = useState<BreakdownView>("bot");
	const lines = linesFor(view, usage);
	const largest = Math.max(0, ...lines.map((line) => line.usd));
	return (
		<SettingsGroup
			label="Breakdown"
			action={
				<SegmentedControl
					label="Break the month down by"
					options={breakdownViews}
					value={view}
					onChange={setView}
				/>
			}
			note={footnote(usage.unpricedRequests)}
		>
			{lines.length === 0 ? (
				<p className="m-0 px-4 py-6 text-center text-muted-foreground text-sm">
					Nothing was spent in {longMonthLabel(usage.month)}.
				</p>
			) : (
				<ul className="m-0 list-none p-0">
					{lines.map((line) => (
						<BreakdownLine key={line.key} line={line} largest={largest} />
					))}
				</ul>
			)}
		</SettingsGroup>
	);
}

function BreakdownLine({ line, largest }: { line: Line; largest: number }) {
	const unknown = line.usd === 0 && line.unpricedRequests > 0;
	return (
		<li className="flex min-w-0 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span aria-hidden className="shrink-0">
				{line.icon}
			</span>
			<span className="flex min-w-0 flex-[1.4] basis-0 flex-col gap-px sm:flex-1">
				<span title={line.label} className="truncate font-medium text-[14px] text-foreground">
					{line.label}
				</span>
				<span className="truncate text-muted-foreground text-xs">{line.sub}</span>
			</span>
			<span
				aria-hidden
				className="h-1.5 min-w-10 flex-1 basis-0 rounded-full bg-chip sm:flex-[1.3]"
			>
				<span
					className="block h-full rounded-full"
					style={{
						width: `${largest > 0 ? (line.usd / largest) * 100 : 0}%`,
						background: line.color,
					}}
				/>
			</span>
			<span className="w-[64px] shrink-0 text-right font-medium text-[14px] text-foreground tabular-nums">
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

function linesFor(view: BreakdownView, usage: WorkspaceUsage): Line[] {
	const systemAgents: Line = {
		key: "system-agents",
		icon: <LetterTile name="System agents" />,
		label: "System agents",
		sub: SYSTEM_AGENTS_WORK,
		color: NEUTRAL_BAR,
		...usage.systemAgents,
	};
	const withSystemAgents = (lines: Line[]) =>
		usage.systemAgents.usd > 0 || usage.systemAgents.unpricedRequests > 0
			? [...lines, systemAgents]
			: lines;

	switch (view) {
		case "bot":
			return withSystemAgents(
				usage.bots.map((bot) => ({
					key: bot.agentId,
					icon: <BotIcon color={bot.color} face={bot.face} name={bot.name} />,
					label: bot.name ?? "Deleted bot",
					sub: bot.podName ?? "No pod",
					color: bot.color ? botColors[bot.color].face : NEUTRAL_BAR,
					usd: bot.usd,
					unpricedRequests: bot.unpricedRequests,
				})),
			);
		case "model":
			return usage.models.map((model) => {
				const label = model.displayName ?? model.model;
				return {
					key: `${model.model}:${model.providerName}`,
					icon: <LetterTile name={label} />,
					label,
					sub:
						model.providerName ??
						(model.preset ? providerPreset(model.preset).name : "Removed provider"),
					color: "var(--primary)",
					usd: model.usd,
					unpricedRequests: model.unpricedRequests,
				};
			});
		case "pod":
			return withSystemAgents(
				usage.pods.map((pod) => {
					const label = pod.name ?? "Deleted pod";
					return {
						key: pod.podId,
						icon: <LetterTile name={label} />,
						label,
						sub: `${pod.botCount} ${pod.botCount === 1 ? "bot" : "bots"}`,
						color: pod.color ? podPalettes[pod.color].swatch : "var(--primary)",
						usd: pod.usd,
						unpricedRequests: pod.unpricedRequests,
					};
				}),
			);
	}
}

function BotIcon({
	color,
	face,
	name,
}: {
	color: AgentColor | null;
	face: AgentFace | null;
	name: string | null;
}) {
	return color ? (
		<AgentAvatar color={color} face={face ?? undefined} size={24} />
	) : (
		<LetterTile name={name ?? "Deleted bot"} />
	);
}

/** The first letter of `name` on a square, for what has no face of its own. */
function LetterTile({ name }: { name: string }) {
	return (
		<span className="grid size-6 place-items-center rounded-[7px] bg-chip font-semibold text-[11px] text-muted-foreground">
			{name.trim().charAt(0).toUpperCase()}
		</span>
	);
}

function footnote(unpricedRequests: number): string {
	const unpriced =
		unpricedRequests === 0
			? ""
			: ` ${unpricedRequests} ${unpricedRequests === 1 ? "request" : "requests"} couldn't be priced and ${unpricedRequests === 1 ? "isn't" : "aren't"} included.`;
	return `Estimated from each provider's published prices.${unpriced} Your provider bills you directly.`;
}
