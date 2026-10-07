import type { Agent, AnsweredApproval, ApprovalRequest } from "@sugabots/contracts";
import { Link, linkOptions, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useApprovalApp } from "@/lib/approval-app.ts";
import { useApprovalInbox } from "@/lib/chats.ts";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { ListColumn, ListTime, quietRowText } from "@/shell/ListColumn.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { PillTabs } from "@/ui/pill-tabs.tsx";

type Tab = "waiting" | "answered";

/** How many answered requests show before Show older. */
const ANSWERED_SHOWN = 10;

/**
 * The column beside the rail for every approval across the workspace: those
 * waiting on the person, and, under its own tab, the latest answered, by day.
 * Each opens in full beside the column.
 */
export function ApprovalList({
	selectedCallId,
	className,
}: {
	/** The request open beside the column. */
	selectedCallId?: string;
	className?: string;
}) {
	const inbox = useApprovalInbox();
	const { agents } = useAgents();
	const waiting = inbox.data?.waiting ?? [];
	const answered = inbox.data?.answered ?? [];
	// Until the person picks a tab or a row, it is the one the open request is under.
	const [chosenTab, setChosenTab] = useState<Tab>();
	const openIsAnswered = answered.some((request) => request.call.id === selectedCallId);
	const tab = chosenTab ?? (openIsAnswered ? "answered" : "waiting");
	const [showAll, setShowAll] = useState(false);
	const chatAgentOf = (request: ApprovalRequest) =>
		agents?.find((agent) => agent.id === request.chatAgentId);
	const answeredShown = showAll ? answered : answered.slice(0, ANSWERED_SHOWN);
	const navigate = useNavigate();

	/** Shows a tab's requests and, where the request is beside the list, opens the first of them. */
	function choose(next: Tab) {
		setChosenTab(next);
		const [first] = next === "waiting" ? waiting : answered;
		if (!first || !matchesMedia(SIDE_BY_SIDE)) return;
		void navigate(approvalLink(first));
	}

	return (
		<ListColumn title="Approvals" className={className}>
			<PillTabs
				label="Show"
				tabs={[
					{
						id: "waiting",
						label: "Waiting on you",
						count: waiting.length,
						countLabel: `${waiting.length} waiting`,
					},
					{ id: "answered", label: "Answered" },
				]}
				selected={tab}
				onSelect={choose}
			/>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
				{inbox.isError && (
					<p className="m-0 px-2.5 py-2 text-muted-foreground">Approvals could not be loaded.</p>
				)}
				{inbox.isSuccess && tab === "waiting" && (
					<ul className="m-0 flex list-none flex-col gap-px p-0">
						{waiting.length === 0 && (
							<li className="px-2.5 py-2 text-md text-muted-foreground">
								Nothing waiting. You're clear.
							</li>
						)}
						{waiting.map((request) => (
							<li key={request.call.id}>
								<WaitingRow
									request={request}
									chatAgent={chatAgentOf(request)}
									selected={request.call.id === selectedCallId}
									// Answering it moves it to Answered; the list stays where the person was.
									onOpen={() => setChosenTab("waiting")}
								/>
							</li>
						))}
					</ul>
				)}
				{inbox.isSuccess && tab === "answered" && (
					<>
						{answered.length === 0 && (
							<p className="m-0 px-2.5 py-2 text-md text-muted-foreground">Nothing answered yet.</p>
						)}
						{byDay(answeredShown).map(({ day, requests }) => (
							<DayGroup key={day.getTime()} label={dayLabel(day)}>
								{requests.map((request) => (
									<li key={request.call.id}>
										<AnsweredRow request={request} selected={request.call.id === selectedCallId} />
									</li>
								))}
							</DayGroup>
						))}
						{answered.length > answeredShown.length && (
							<button
								type="button"
								onClick={() => setShowAll(true)}
								className="focus-ring mt-1 self-start rounded-sm px-2.5 py-1 font-medium text-[13px] text-link"
							>
								Show older
							</button>
						)}
					</>
				)}
			</div>
		</ListColumn>
	);
}

/** A request's own page, beside the list. */
function approvalLink(request: ApprovalRequest) {
	return linkOptions({
		from: "/$workspace",
		to: "./approvals/$call",
		params: { call: request.call.id },
	});
}

function DayGroup({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col pt-2">
			<h2 className="m-0 px-2.5 pb-1 font-medium text-subtle-foreground text-xs">{label}</h2>
			<ul className="m-0 flex list-none flex-col gap-px p-0">{children}</ul>
		</div>
	);
}

/** Answered requests in runs by the local day they were answered on, newest first. */
function byDay(
	requests: readonly AnsweredApproval[],
): { day: Date; requests: AnsweredApproval[] }[] {
	const days = new Map<number, AnsweredApproval[]>();
	for (const request of requests) {
		const day = startOfDay(new Date(request.answer.decidedAt)).getTime();
		days.set(day, [...(days.get(day) ?? []), request]);
	}
	return [...days].map(([day, onDay]) => ({ day: new Date(day), requests: onDay }));
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const DAY_MS = 24 * 60 * 60_000;
const WEEK_DAYS = 7;

/** "Today", "Yesterday", the weekday within the week, then the date, with its year when not this one. */
function dayLabel(day: Date, now = new Date()): string {
	const daysAgo = Math.round((startOfDay(now).getTime() - day.getTime()) / DAY_MS);
	if (daysAgo <= 0) return "Today";
	if (daysAgo === 1) return "Yesterday";
	if (daysAgo < WEEK_DAYS) return day.toLocaleDateString(undefined, { weekday: "long" });
	return day.toLocaleDateString(
		undefined,
		day.getFullYear() === now.getFullYear()
			? { day: "numeric", month: "short" }
			: { day: "numeric", month: "short", year: "numeric" },
	);
}

const rowClassName = (selected: boolean) =>
	cn(
		"focus-ring flex rounded-tail px-2.5 transition-colors",
		selected ? "bg-row-selected" : "hover:bg-row-hover",
	);

/** A request waiting on the person: the app's mark, what the bot would do, who asked, and when. */
function WaitingRow({
	request,
	chatAgent,
	selected,
	onOpen,
}: {
	request: ApprovalRequest;
	chatAgent?: Agent;
	selected: boolean;
	onOpen: () => void;
}) {
	const { agent, call } = request;
	const { look, appName, action } = useApprovalApp(request);
	return (
		<Link
			{...approvalLink(request)}
			onClick={onOpen}
			aria-current={selected ? "page" : undefined}
			className={cn(rowClassName(selected), "gap-2.5 py-2")}
		>
			<span aria-hidden className="mt-px flex shrink-0">
				<ConnectionMark presetId={look?.presetId} name={appName} size="md" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate font-semibold text-[13.5px] text-foreground">
						{action}
					</span>
					<ListTime at={call.startedAt} selected={selected} />
				</span>
				<span className="truncate text-[12.5px] text-muted-foreground">
					{chatAgent && chatAgent.id !== agent.id
						? `${agent.name} in ${chatAgent.name}`
						: agent.name}
				</span>
			</span>
		</Link>
	);
}

/** A request already answered: the app's mark, what the bot would have done, which bot, and which way it went. */
function AnsweredRow({ request, selected }: { request: AnsweredApproval; selected: boolean }) {
	const { look, appName, action } = useApprovalApp(request);
	const allowed = request.answer.status === "allowed";
	return (
		<Link
			{...approvalLink(request)}
			aria-current={selected ? "page" : undefined}
			className={cn(rowClassName(selected), "items-center gap-2.5 py-2")}
		>
			<span aria-hidden className="flex shrink-0">
				<ConnectionMark presetId={look?.presetId} name={appName} size="md" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-semibold text-[13.5px] text-foreground">{action}</span>
				<span className="truncate text-[12.5px] text-muted-foreground">{request.agent.name}</span>
			</span>
			<span
				className={cn(
					"shrink-0 font-semibold text-xs",
					allowed ? quietRowText(selected) : "text-destructive-text",
				)}
			>
				{allowed ? "Allowed" : "Denied"}
			</span>
		</Link>
	);
}
