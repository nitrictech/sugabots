import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronRight, Wrench } from "lucide-react";
import { useId, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import {
	ARTIFACT_TOOL_PREFIX,
	BROWSER_TOOL_PREFIX,
	BUILT_IN_HANDLE,
	connectionLabel,
	splitToolKey,
	wordsFromKey,
} from "@/lib/tool-names.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { McpAppFrame } from "./McpAppFrame.tsx";
import { ToolCallValue } from "./ToolCallValue.tsx";
import { awaitsApproval, durationOf, formatDuration, formatTotal } from "./tool-activity.ts";
import {
	describeStep,
	outputValue,
	type StepDetails,
	stepDetails,
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
	/** The thread's files by id, for the calls that read them. */
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
				className="focus-ring flex max-w-full items-center gap-1.5 rounded-md pb-1.5 font-medium text-muted-foreground text-sm transition-colors hover:text-soft-foreground"
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
					className="m-0 mb-2 flex w-full max-w-[560px] list-none flex-col border-hover border-l-[1.5px] py-0.5 pl-3.5"
				>
					{runs.flatMap((run, index) => [
						run.narration && (
							<li
								key={`narration@${run.calls[0]?.id}`}
								className={cn(
									"text-[13px] text-muted-foreground leading-snug",
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
			{calls
				.filter((call) => call.hasApp && call.status === "completed")
				.map((call) => (
					<McpAppFrame key={call.id} call={call} className="mb-2 max-w-[560px]" />
				))}
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
				className="focus-ring -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-[3px] text-left transition-colors hover:bg-hover"
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
				<span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
					<span className="shrink-0 font-medium text-soft-foreground">{action}</span>
					{subject && (
						<span
							title={subject.text}
							className={cn(
								"min-w-0 truncate",
								subject.asCode
									? "font-mono text-[12.5px] text-subtle-foreground"
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
							"min-w-0 max-w-[40%] shrink-0 truncate text-[12px]",
							note.failed ? "text-destructive-text" : "text-subtle-foreground",
						)}
					>
						{note.text}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
					{call.finishedAt && (
						<span className="font-mono text-[11.5px] text-subtle-foreground">
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
			<p className="m-0 flex items-baseline gap-1.5 text-[11.5px] text-subtle-foreground">
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
				<p className="m-0 text-[12px] text-subtle-foreground">
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
			<figcaption id={labelId} className="font-medium text-[11.5px] text-subtle-foreground">
				{label}
			</figcaption>
			<ToolCallValue value={value} otherArguments={otherArguments} failed={failed} />
			{footnote && <p className="m-0 text-[11.5px] text-subtle-foreground">{footnote}</p>}
		</figure>
	);
}

/** The app a call reached, by name: the connection, or the built-in tool itself ("Web search"). */
function appOf(call: ToolCallPart, look?: ConnectionLook): string {
	const { handle } = splitToolKey(call.tool);
	if (call.tool.startsWith(BROWSER_TOOL_PREFIX)) return "Browser";
	if (call.tool.startsWith(ARTIFACT_TOOL_PREFIX)) return "Artifacts";
	return handle === BUILT_IN_HANDLE ? wordsFromKey(call.tool) : connectionLabel(handle, look?.name);
}

/**
 * The line's words. Finished calls are "used"; then, at most one of what the
 * reply is stopped on: a call waiting for approval, one still running, or one
 * that was refused.
 */
export function toolLineText(
	calls: readonly ToolCallPart[],
	looks: ReadonlyMap<string, ConnectionLook>,
): string {
	const apps = (matching: (call: ToolCallPart) => boolean) =>
		listed([
			...new Set(
				calls
					.filter(matching)
					.map((call) => appOf(call, looks.get(splitToolKey(call.tool).handle))),
			),
		]);
	const denied = (call: ToolCallPart) => call.approval?.status === "denied";
	const waiting = awaitsApproval;
	// An allowed call is as good as running: its turn starts it a moment later.
	const running = (call: ToolCallPart) =>
		call.status === "running" ||
		(call.status === "awaiting_approval" && call.approval?.status === "allowed");
	const finished = (call: ToolCallPart) =>
		(call.status === "completed" || call.status === "failed") && !denied(call);

	const used = apps(finished);
	const tail = calls.some(waiting)
		? `waiting on ${apps(waiting)} approval`
		: calls.some(running)
			? `using ${apps(running)}`
			: calls.some(denied)
				? `${apps(denied)} denied`
				: undefined;

	if (!tail) {
		const totalMs = calls.filter(finished).reduce((sum, call) => sum + durationOf(call), 0);
		return `Used ${used} for ${formatTotal(totalMs)}`;
	}
	return used ? `Used ${used}, ${tail}` : capitalised(tail);
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What there is to say about how a call went beyond what it did: that it is
 * waiting, running, was refused or failed and why, or how many results it
 * found. Nothing, for a call that simply worked.
 */
function noteOf(call: ToolCallPart): { text: string; failed: boolean } | undefined {
	const failed = (text: string) => ({ text, failed: true });
	const said = (text: string) => ({ text, failed: false });
	if (call.approval?.status === "denied") {
		return failed(
			call.approval.decidedByName ? `Denied by ${call.approval.decidedByName}` : "Denied",
		);
	}
	if (call.status === "failed") return failed(call.error ?? "Failed");
	if (awaitsApproval(call)) return said("Waiting for approval");
	if (call.status === "awaiting_approval") {
		return said(
			call.approval?.decidedByName ? `Allowed by ${call.approval.decidedByName}` : "Allowed",
		);
	}
	if (call.status === "running") return said("Running");
	const refusal = refusalIn(call.output);
	if (refusal) return failed(refusal);
	const count = resultCountIn(outputValue(call.output));
	return count === undefined ? undefined : said(resultCount(count));
}

/**
 * Why a tool that answered said no, for the shapes tools refuse in:
 * `{ ok: false, reason }`, `{ status: "refused" | "failed", reason | error }`,
 * `{ refused }`, an MCP server's `{ isError, content }`, and a command's
 * non-zero `exitCode` or timeout.
 */
function refusalIn(output: unknown): string | undefined {
	if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
	const answer = output as Record<string, unknown>;
	const why = [answer.reason, answer.error, answer.message].find(
		(value): value is string => typeof value === "string",
	);
	if (typeof answer.refused === "string") return answer.refused;
	if (answer.ok === false || answer.status === "refused" || answer.status === "failed") {
		return why ?? "Failed";
	}
	if (answer.isError === true) {
		const said = outputValue(output);
		return typeof said === "string" ? said : "Failed";
	}
	if (typeof answer.exitCode === "number" && answer.exitCode !== 0)
		return `Exit ${answer.exitCode}`;
	if (answer.timedOut === true) return "Timed out";
	return undefined;
}

/** How many things a call found: its output's list, or the one list inside it. Images it was shown are not results. */
function resultCountIn(output: unknown): number | undefined {
	if (Array.isArray(output)) return output.length;
	if (output === null || typeof output !== "object") return undefined;
	const list = Object.entries(output).find(
		([key, value]) => key !== "images" && Array.isArray(value),
	)?.[1] as unknown[] | undefined;
	return list?.length;
}

function resultCount(count: number): string {
	return `${count} ${count === 1 ? "result" : "results"}`;
}
