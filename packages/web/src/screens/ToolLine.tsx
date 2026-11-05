import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronRight, Wrench } from "lucide-react";
import { useId, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { BUILT_IN_HANDLE, splitToolKey } from "@/lib/tool-names.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { ToolCallValue } from "./ToolCallValue.tsx";
import { durationOf, formatDuration } from "./tool-activity.ts";
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
