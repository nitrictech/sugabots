import type { Message, MessagePart, ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronRight, Wrench } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { BUILT_IN_HANDLE, splitToolKey } from "@/lib/tool-names.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/ui/trace.tsx";
import { ToolCallValue } from "./ToolCallValue.tsx";
import { awaitsApproval, durationOf, formatDuration, formatElapsed } from "./tool-activity.ts";
import {
	appOf,
	describeStep,
	noteOf,
	type StepDetails,
	stepDetails,
	toolLineText,
	toolStepRuns,
} from "./tool-steps.ts";

/**
 * What a bot used on the way to a reply, as one line above it: "Used HubSpot
 * for 4s", or "Used Sentry, waiting on Linear approval". Opening it lists the
 * calls under what the bot said it was doing, each as what it did to what, with
 * anything worth knowing about how it went and how long it took.
 */
export function ToolLine({
	parts,
	looks,
	fileNames,
	className,
}: {
	/** The reply's parts: its calls, and the narration that introduced them. */
	parts: readonly MessagePart[];
	looks: ReadonlyMap<string, ConnectionLook>;
	/** The conversation's files by id, for the calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const runs = toolStepRuns(parts);
	const calls = runs.flatMap((run) => run.calls);
	if (calls.length === 0) return null;

	return (
		<div className={cn("flex min-w-0 flex-col items-start", className)}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen(!open)}
				className="focus-ring flex max-w-full items-center gap-1.5 rounded-md pb-1.5 font-medium text-muted-foreground text-xs transition-colors hover:text-soft-foreground"
			>
				<span className="min-w-0 truncate">{toolLineText(calls, looks)}</span>
				<ChevronRight
					aria-hidden
					size={10}
					strokeWidth={3}
					className={cn(
						"shrink-0 text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && (
				<ul
					id={listId}
					className="m-0 mb-2 flex w-full max-w-140 list-none flex-col border-hover border-l-2 py-0.5 pl-3.5"
				>
					{runs.flatMap((run, index) => [
						run.narration && (
							<li
								key={`narration@${run.calls[0]?.id}`}
								className={cn(
									"text-xs text-muted-foreground leading-snug",
									index > 0 && "pt-2",
									"pb-0.5",
								)}
							>
								{run.narration}
							</li>
						),
						...run.calls.map((call) => (
							<ToolCallRow
								key={call.id}
								call={call}
								look={looks.get(splitToolKey(call.tool).handle)}
								fileNames={fileNames}
							/>
						)),
					])}
				</ul>
			)}
		</div>
	);
}

/** One call: what it did to what, how it went and how long it took; opened, what it was given and what came back. */
function ToolCallRow({
	call,
	look,
	fileNames,
}: {
	call: ToolCallPart;
	look?: ConnectionLook;
	fileNames: ReadonlyMap<string, string>;
}) {
	const [open, setOpen] = useState(false);
	const detailsId = useId();
	const { handle } = splitToolKey(call.tool);
	const { action, subject } = describeStep(call, fileNames);
	const note = noteOf(call);
	const details = stepDetails(call);
	return (
		<li className="flex min-w-0 flex-col">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={detailsId}
				onClick={() => setOpen(!open)}
				className="focus-ring -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.75 text-left transition-colors hover:bg-hover"
			>
				{handle === BUILT_IN_HANDLE ? (
					// Built into every bot, so it has no app's mark: a tool's.
					<span
						aria-hidden
						className="grid size-4 shrink-0 place-items-center rounded-xs bg-border-strong text-soft-foreground"
					>
						<Wrench size={10} strokeWidth={2.4} />
					</span>
				) : (
					<ConnectionMark presetId={look?.presetId} name={appOf(call, look)} size="xs" />
				)}
				<span className="flex min-w-0 items-baseline gap-1.5 text-xs">
					<span className="shrink-0 font-medium text-soft-foreground">{action}</span>
					{subject && (
						<span
							title={subject.text}
							className={cn(
								"min-w-0 truncate",
								subject.asCode
									? "font-mono text-xs text-subtle-foreground"
									: "text-muted-foreground",
							)}
						>
							{subject.text}
						</span>
					)}
				</span>
				{note && (
					<span
						title={note.text}
						className={cn(
							"min-w-0 max-w-2/5 shrink-0 truncate text-xs",
							note.failed ? "text-destructive-text" : "text-subtle-foreground",
						)}
					>
						{note.text}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
					{call.finishedAt && (
						<span className="font-mono text-2xs text-subtle-foreground">
							{formatDuration(durationOf(call))}
						</span>
					)}
					<ChevronRight
						aria-hidden
						size={10}
						strokeWidth={3}
						className={cn(
							"text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
				</span>
			</button>
			{open && <CallDetails id={detailsId} call={call} details={details} />}
		</li>
	);
}

function CallDetails({
	id,
	call,
	details,
}: {
	id: string;
	call: ToolCallPart;
	details: StepDetails;
}) {
	return (
		<div id={id} className="flex flex-col gap-2 pt-1 pb-2 pl-6">
			<p className="m-0 flex items-baseline gap-1.5 text-2xs text-subtle-foreground">
				<span className="font-medium">Tool</span>
				<code className="font-mono text-soft-foreground">{call.tool}</code>
			</p>
			{details.input !== undefined && (
				<DetailBlock label="Input" value={details.input} otherArguments={details.otherArguments} />
			)}
			{call.error ? (
				<DetailBlock label="Error" value={call.error} failed />
			) : (
				details.output !== undefined && (
					<DetailBlock label="Output" value={details.output} footnote={details.outputCut} />
				)
			)}
			{details.input === undefined && details.output === undefined && !call.error && (
				<p className="m-0 text-xs text-subtle-foreground">
					{call.status === "running" ? "Still running" : "Nothing to show"}
				</p>
			)}
		</div>
	);
}

/** A labelled part of a call: its input, its output or its error. */
function DetailBlock({
	label,
	value,
	otherArguments,
	failed,
	footnote,
}: {
	label: string;
	value: unknown;
	otherArguments?: unknown;
	failed?: boolean;
	/** What a reader should know about the value, under it: that it is not all of it. */
	footnote?: string;
}) {
	const labelId = useId();
	return (
		<figure aria-labelledby={labelId} className="m-0 flex min-w-0 flex-col gap-1">
			<figcaption id={labelId} className="font-medium text-2xs text-subtle-foreground">
				{label}
			</figcaption>
			<ToolCallValue value={value} otherArguments={otherArguments} failed={failed} />
			{footnote && <p className="m-0 text-2xs text-subtle-foreground">{footnote}</p>}
		</figure>
	);
}

/**
 * How long a bot worked on a reply, as one line over it: "Working for 12s",
 * counting, while it does, and "Worked for 4m 1s" once it is done. Opening it
 * lists what the bot did on the way: what it said it was doing, then a line
 * for each app it used, which opens to its calls, each of which opens to what
 * came back. Every level sits flush with the one above.
 */
export function WorkedFor({
	message,
	looks,
	fileNames,
	className,
}: {
	message: Message;
	looks: ReadonlyMap<string, ConnectionLook>;
	/** The conversation's files by id, for the calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	className?: string;
}) {
	// Open while the bot works, so its steps show as it takes them; shut once it is done, unless toggled.
	const [toggled, setToggled] = useState<boolean>();
	// A reply stopped on a call someone has to approve isn't being worked on.
	const waiting = message.parts.some((part) => part.type === "tool_call" && awaitsApproval(part));
	const working = message.status === "streaming" && !waiting;
	const now = useNow(working);
	const runs = toolStepRuns(message.parts);
	const calls = runs.flatMap((run) => run.calls);
	const label = waiting ? "Waiting for approval" : workedForText(message, now, calls, looks);
	if (!label) return null;
	const line = (
		<TraceLine status={working ? "running" : undefined}>
			<TraceTitle className="tabular-nums">{label}</TraceTitle>
		</TraceLine>
	);
	return (
		<Trace className={cn("border-border border-b pb-2.5", className)}>
			{calls.length === 0 ? (
				line
			) : (
				<TraceCollapsible open={toggled ?? working} onOpenChange={setToggled}>
					<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
					<TraceCollapsibleContent className={FLUSH}>
						<Trace>
							{runs.flatMap((run, index) => {
								const sections = byApp(run.calls);
								return [
									run.narration && (
										<p
											key={`narration@${run.calls[0]?.id}`}
											className="m-0 text-body-foreground text-sm leading-relaxed"
										>
											{run.narration}
										</p>
									),
									...sections.map((section, sectionIndex) => (
										<AppSection
											key={`steps@${section[0]?.id}`}
											calls={section}
											looks={looks}
											fileNames={fileNames}
											current={
												working && index === runs.length - 1 && sectionIndex === sections.length - 1
											}
										/>
									)),
								];
							})}
						</Trace>
					</TraceCollapsibleContent>
				</TraceCollapsible>
			)}
		</Trace>
	);
}

/** What a collapsible's contents lose of `Trace`'s indent and rule, so each level sits flush with the one above. */
const FLUSH = "ml-0 border-l-0 pl-0 pr-0";

/**
 * The work line's words. A reply with no time to give, from before replies
 * kept when they ended, says what it used instead, or nothing.
 */
function workedForText(
	message: Message,
	now: number,
	calls: readonly ToolCallPart[],
	looks: ReadonlyMap<string, ConnectionLook>,
): string | undefined {
	const startedAt = Date.parse(message.createdAt);
	if (message.status === "streaming") return `Working for ${formatElapsed(now - startedAt)}`;
	const workedMs = message.finishedAt ? Date.parse(message.finishedAt) - startedAt : 0;
	// A reply recorded as done the moment it began has no time worth telling.
	if (workedMs >= SECOND_MS) return `Worked for ${formatElapsed(workedMs)}`;
	return calls.length > 0 ? toolLineText(calls, looks) : undefined;
}

const SECOND_MS = 1_000;

/** The time now, a second at a time while `ticking`; while not, the time it stopped. */
function useNow(ticking: boolean): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}

/**
 * Calls made one after another, split wherever the app changes, so each
 * section is one app's. Tools built into every bot share no app, so each of
 * them is its own: commands with commands, page reads with page reads.
 */
function byApp(calls: readonly ToolCallPart[]): ToolCallPart[][] {
	const appKey = (call: ToolCallPart) => {
		const { handle } = splitToolKey(call.tool);
		return handle === BUILT_IN_HANDLE ? call.tool : handle;
	};
	const sections: ToolCallPart[][] = [];
	for (const call of calls) {
		const last = sections.at(-1);
		const previous = last?.at(-1);
		if (last && previous && appKey(previous) === appKey(call)) last.push(call);
		else sections.push([call]);
	}
	return sections;
}

/**
 * Calls a bot made one after another in one app, as one line saying so:
 * "Used HubSpot for 4s · 3 steps". Opened, the calls, in a list that scrolls
 * once it is long. A single call needs no summary, so is shown as itself.
 */
function AppSection({
	calls,
	looks,
	fileNames,
	current,
}: {
	calls: readonly ToolCallPart[];
	looks: ReadonlyMap<string, ConnectionLook>;
	fileNames: ReadonlyMap<string, string>;
	/** The calls the bot is making now, open so the running one shows. */
	current: boolean;
}) {
	const [toggled, setToggled] = useState<boolean>();
	const first = calls[0];
	if (!first) return null;
	if (calls.length === 1) return <CallLine call={first} looks={looks} fileNames={fileNames} />;
	const failed = calls.some((call) => call.status === "failed");
	return (
		<TraceCollapsible open={toggled ?? current} onOpenChange={setToggled}>
			<TraceCollapsibleTrigger>
				<TraceLine status={lineStatus(calls)}>
					<CallMark call={first} look={looks.get(splitToolKey(first.tool).handle)} />
					<TraceTitle>{toolLineText(calls, looks)}</TraceTitle>
					<TraceDescription className={cn(failed && "text-destructive-text")}>
						{calls.length} steps
					</TraceDescription>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className={FLUSH}>
				<Trace className="scrollbar-on-hover max-h-80 overflow-y-auto overscroll-contain">
					{calls.map((call) => (
						<CallLine key={call.id} call={call} looks={looks} fileNames={fileNames} />
					))}
				</Trace>
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

/** How a line for `calls` reads: shimmering while one runs, red once one has failed. */
function lineStatus(calls: readonly ToolCallPart[]): "running" | "error" | undefined {
	if (calls.some((call) => call.status === "running")) return "running";
	if (calls.some((call) => call.status === "failed")) return "error";
	return undefined;
}

/** A call's app's mark, or a tool's for one built into every bot. */
function CallMark({ call, look }: { call: ToolCallPart; look?: ConnectionLook }) {
	return (
		<TraceIcon>
			{splitToolKey(call.tool).handle === BUILT_IN_HANDLE ? (
				<Wrench strokeWidth={1.75} />
			) : (
				<ConnectionMark presetId={look?.presetId} name={appOf(call, look)} size="xs" />
			)}
		</TraceIcon>
	);
}

/** One call: its mark, what it did to what, and how it went; opened, what came back. */
function CallLine({
	call,
	looks,
	fileNames,
}: {
	call: ToolCallPart;
	looks: ReadonlyMap<string, ConnectionLook>;
	fileNames: ReadonlyMap<string, string>;
}) {
	const [inputShown, setInputShown] = useState(false);
	const look = looks.get(splitToolKey(call.tool).handle);
	const { action, subject } = describeStep(call, fileNames);
	const note = noteOf(call);
	const details = stepDetails(call);
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>
				<TraceLine status={lineStatus([call])}>
					<CallMark call={call} look={look} />
					<TraceTitle>
						{action}
						{subject && (
							<span
								title={subject.text}
								className={cn("text-subtle-foreground", subject.asCode && "font-mono")}
							>
								{" "}
								{subject.text}
							</span>
						)}
					</TraceTitle>
					{note && (
						<TraceDescription
							title={note.text}
							className={cn("max-w-2/5 truncate", note.failed && "text-destructive-text")}
						>
							{note.text}
						</TraceDescription>
					)}
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className={FLUSH}>
				<div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-list px-3.5 py-3 text-xs">
					{call.error ? (
						<DetailBlock label="Error" value={call.error} failed />
					) : details.output !== undefined ? (
						<>
							<ToolCallValue value={details.output} />
							{details.outputCut && (
								<p className="m-0 text-2xs text-subtle-foreground">{details.outputCut}</p>
							)}
						</>
					) : (
						<p className="m-0 text-subtle-foreground">
							{call.status === "running" ? "Still running" : "Nothing came back"}
						</p>
					)}
					<button
						type="button"
						aria-expanded={inputShown}
						onClick={() => setInputShown(!inputShown)}
						className="focus-ring self-start rounded-sm text-subtle-foreground transition-colors hover:text-foreground"
					>
						{inputShown ? "Hide input" : "Show input"}
					</button>
					{inputShown && (
						<>
							<p className="m-0 flex items-baseline gap-1.5 text-2xs text-subtle-foreground">
								<span className="font-medium">Tool</span>
								<code className="font-mono text-soft-foreground">{call.tool}</code>
							</p>
							{details.input !== undefined && (
								<DetailBlock
									label="Input"
									value={details.input}
									otherArguments={details.otherArguments}
								/>
							)}
						</>
					)}
				</div>
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}
