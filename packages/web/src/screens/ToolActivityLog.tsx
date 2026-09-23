import { Wrench } from "lucide-react";
import { useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import {
	type ActivityEntry,
	type ActivityStep,
	BUILT_IN_HANDLE,
	formatDuration,
	formatTotal,
	stepErrors,
	type ToolActivity,
} from "./tool-activity.ts";

/*
 * Everything a reply did on the way to its answer, as one scrollable timeline:
 * what the agent said, and the steps it took, in order, with back-to-back
 * repeats folded into a single row. It says what happened and stops there — a
 * step is read, not opened.
 *
 * This is a plain first pass at the timeline, pending its own design.
 *
 * It takes what it draws and nothing else, so it can sit in a dialog now and
 * in a docked panel later without changing.
 */

export function ToolActivityLog({
	activity,
	looks,
	at,
	headingId,
	className = "",
}: {
	activity: ToolActivity;
	/** Connection handles to the name and mark their steps are shown under. */
	looks?: ReadonlyMap<string, ConnectionLook>;
	/** When the reply these steps belong to landed. */
	at?: string;
	/** Set by a surface that labels itself from this log's heading. */
	headingId?: string;
	className?: string;
}) {
	/*
	 * The roll-up only. Which connections were used is not said here because
	 * every step carries its connection's mark — writing it out again turned the
	 * one line meant to be read at a glance into a sentence.
	 */
	const summary = [
		`${activity.stepCount} ${activity.stepCount === 1 ? "step" : "steps"}`,
		formatTotal(activity.durationMs),
		at ? formatTime(at) : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className={`flex h-full min-h-0 flex-col ${className}`}>
			<header className="flex flex-col gap-1 border-border-subtle border-b px-4 pb-3">
				<h2 id={headingId} className="m-0 font-semibold text-base text-heading">
					Activity
				</h2>
				<p className="m-0 text-muted-foreground text-xs">{summary}</p>
			</header>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-1 px-4 py-2">
					{runsOf(activity.entries).map((run) =>
						run.type === "said" ? (
							<p
								key={run.key}
								className="m-0 whitespace-pre-wrap pt-2 text-muted-foreground text-sm"
							>
								{run.text}
							</p>
						) : (
							<ol key={run.key} className="m-0 flex list-none flex-col p-0">
								{run.steps.map((step) => (
									<Step key={step.key} step={step} look={looks?.get(step.handle)} />
								))}
							</ol>
						),
					)}
					{activity.stepCount === 0 && (
						<p className="m-0 py-6 text-center text-muted-foreground text-xs">
							This reply used no tools.
						</p>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

type Run =
	| Extract<ActivityEntry, { type: "said" }>
	| { type: "steps"; key: string; steps: ActivityStep[] };

/** The entries with each stretch of back-to-back steps gathered into one list. */
function runsOf(entries: readonly ActivityEntry[]): Run[] {
	const runs: Run[] = [];
	for (const entry of entries) {
		if (entry.type === "said") {
			runs.push(entry);
			continue;
		}
		const previous = runs.at(-1);
		if (previous?.type === "steps") {
			previous.steps.push(entry.step);
			continue;
		}
		runs.push({ type: "steps", key: entry.key, steps: [entry.step] });
	}
	return runs;
}

/** The step's connection as its mark; the product's own tools get a wrench on a neutral tile. */
function StepMark({ step, look }: { step: ActivityStep; look?: ConnectionLook }) {
	if (step.handle === BUILT_IN_HANDLE) {
		return (
			<span
				aria-hidden
				className="grid size-4 shrink-0 place-items-center self-center rounded-xs bg-muted text-muted-foreground"
			>
				<Wrench className="size-2.5" />
			</span>
		);
	}
	return (
		<span className="shrink-0 self-center">
			<ConnectionMark
				presetId={look?.presetId}
				name={look?.name ?? step.connection}
				hue={look?.hue ?? 250}
				size="xs"
			/>
		</span>
	);
}

/*
 * A step reads, it does not open — with one exception. A failure is the only
 * thing here a reader has to act on, and the row cannot hold the reason, so a
 * failed step alone opens, and to its error and nothing else.
 *
 * It carries no chevron. Nothing may come after the duration or the times stop
 * lining up, and a disclosure leading the row indents every other one to keep
 * the labels flush. The red row is the affordance: it presses, and assistive
 * technology is told it expands.
 */
function Step({ step, look }: { step: ActivityStep; look?: ConnectionLook }) {
	const [open, setOpen] = useState(false);
	const failed = step.outcome === "error";
	const row = (
		<>
			<StepMark step={step} look={look} />
			<span className="sr-only">{step.connection} · </span>
			<span
				className={`min-w-0 flex-1 truncate text-sm ${
					failed ? "font-medium text-destructive" : "text-foreground"
				}`}
			>
				{step.label}
				{/* A write the thread refused never ran, which its row alone cannot show. */}
				{step.outcome === "skipped" && <span className="text-muted-foreground"> — not run</span>}
			</span>
			{step.count > 1 && (
				<span className="shrink-0 rounded-full bg-sunken px-1.5 font-mono text-2xs text-muted-foreground">
					×{step.count}
				</span>
			)}
			<span className="shrink-0 text-2xs text-muted-foreground">
				{formatDuration(step.durationMs)}
			</span>
		</>
	);
	if (!failed) {
		return <li className="flex items-baseline gap-2 py-1.5">{row}</li>;
	}
	const reasons = stepErrors(step);
	return (
		<li className="flex flex-col">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((was) => !was)}
				// The press area is inset past the text on both sides, so the highlight
				// has room around what it highlights; the negative margin keeps the
				// label and the duration in the same columns as every other row.
				className="focus-ring -mx-2 flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken"
			>
				{row}
			</button>
			{open && (
				<div className="flex flex-col gap-1 pb-2">
					{reasons.length > 0 ? (
						reasons.map((reason) => (
							/*
							 * A server answers a failure with whatever it likes: one line, or a
							 * stack trace whose paths hold no break of their own. `anywhere` is
							 * what keeps those from running off the right edge and being clipped
							 * away, which is what happened at a phone's width. It is shown whole
							 * rather than capped — someone opened this to read it, and a scroller
							 * inside the panel's own scroller earns its keep in neither.
							 * Monospace because it is machine output.
							 */
							<pre
								key={reason}
								className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-destructive/5 px-2 py-1.5 font-mono text-2xs text-destructive"
							>
								{reason}
							</pre>
						))
					) : (
						<p className="m-0 text-muted-foreground text-xs">No reason was recorded.</p>
					)}
				</div>
			)}
		</li>
	);
}

function formatTime(at: string): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
		new Date(at),
	);
}
