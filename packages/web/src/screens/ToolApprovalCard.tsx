import type { ThreadParticipant, ToolCallPart } from "@sugabots/contracts";
import { Check, Copy, Maximize2 } from "lucide-react";
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { useElapsedSince } from "@/lib/elapsed.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Dialog, DialogContent } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { connectionLabel, splitToolKey, stepLabel, wordsFromKey } from "./tool-activity.ts";

/*
 * A write an agent wants to make, and the run stopped until someone answers.
 *
 * Reads are summarised after the fact in the activity log and leave the thread
 * alone; a write cannot be, because by the time it could be summarised it has
 * already happened. So this is the one piece of tool machinery that still
 * interrupts: it shows the exact thing about to be done and what it would be
 * sent, as fields rather than JSON, because what is being judged is the record
 * that is about to exist.
 *
 * It reads as the agent asking, in the thread: who wants it on a line above,
 * then one surface holding the step, its fields and the answer. However large
 * the request, the card stays the size of a question: it shows the first few
 * fields or entries in brief, counts the rest, and the whole request is behind
 * its expand button, where it can be answered too.
 */

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

type Asker = Pick<AgentParticipant, "name" | "hue" | "face">;

export function ToolApprovalCard({
	call,
	agent,
	threadId,
	podId,
	canApprove,
	canAlwaysAllow,
	look,
}: {
	call: ToolCallPart;
	/** The agent whose run is waiting on this. */
	agent: Asker;
	threadId: string;
	podId: string;
	canApprove: boolean;
	canAlwaysAllow: boolean;
	look?: ConnectionLook;
}) {
	const review = useReviewToolCall(threadId, podId);
	const [always, setAlways] = useState(false);
	const [requestOpen, setRequestOpen] = useState(false);
	const waitingMs = useElapsedSince(call.startedAt);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, look?.name) : "";
	const label = stepLabel(call.tool, name);
	const title = where ? `${label} in ${where}` : label;
	const wants = call.mutating ? "wants to make a change" : "wants to use a tool";
	// One answer, drawn on the card and again in the full request, so the
	// "always" choice and a pending decision are the same wherever it is given.
	const answer = canApprove ? (
		<Answer
			canAlwaysAllow={canAlwaysAllow}
			always={always}
			onAlwaysChange={setAlways}
			alwaysOf={title}
			pending={review.isPending}
			error={review.error}
			onDeny={() => review.mutate({ toolCallId: call.id, decision: "deny" })}
			onApprove={() =>
				review.mutate({
					toolCallId: call.id,
					decision: always ? "always_allow" : "allow_once",
				})
			}
		/>
	) : (
		<p className="m-0 text-muted-foreground text-xs">
			Waiting for someone with permission to answer this.
		</p>
	);
	return (
		<section
			aria-label={`Approval needed: ${title}`}
			className="agent-tint flex animate-rise flex-col gap-2 pr-8 pl-3.5 motion-reduce:animate-none"
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<p className="m-0 flex items-start gap-2 text-muted-foreground text-xs">
				<AgentAvatar hue={agent.hue} face={agent.face} size={20} className="shrink-0" />
				<span className="min-w-0 self-center">
					<span className="font-semibold text-agent-name">{agent.name}</span> {wants}
					<span aria-hidden> · </span>
					<span className="whitespace-nowrap">waiting {formatWaiting(waitingMs)}</span>
				</span>
			</p>

			<div className="flex w-full max-w-[min(100%,480px)] flex-col gap-3 rounded-2xl border border-agent-wash bg-card p-3.5 shadow-card">
				<StepHeading
					look={look}
					label={label}
					where={where}
					action={
						<IconButton label="View full request" onClick={() => setRequestOpen(true)}>
							<Maximize2 aria-hidden />
						</IconButton>
					}
				/>
				<RequestSummary input={call.input} />
				<div className="border-border-subtle border-t pt-3">{answer}</div>
			</div>

			<RequestDialog
				input={call.input}
				agent={agent}
				wants={wants}
				look={look}
				label={label}
				where={where}
				answer={answer}
				open={requestOpen}
				onOpenChange={setRequestOpen}
			/>
		</section>
	);
}

/** The connection's logo beside what the step does, and a line under it: where, unless told otherwise. */
function StepHeading({
	look,
	label,
	where,
	detail = where,
	headingId,
	action,
}: {
	look?: ConnectionLook;
	label: string;
	where: string;
	detail?: string;
	/** Set where the heading names a surface, as the full request's does. */
	headingId?: string;
	/** A control at the heading's far end. */
	action?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<ConnectionMark
				presetId={look?.presetId}
				name={where || label}
				hue={look?.hue ?? 250}
				size="sm"
			/>
			<span className="flex min-w-0 flex-col">
				<span id={headingId} className="font-semibold text-base text-heading">
					{label}
				</span>
				{detail && <span className="text-muted-foreground text-xs">{detail}</span>}
			</span>
			{action && <span className="ml-auto self-start">{action}</span>}
		</div>
	);
}

/** Always-allow, Deny and Approve on one row, and what went wrong if answering failed. */
function Answer({
	canAlwaysAllow,
	always,
	onAlwaysChange,
	alwaysOf,
	pending,
	error,
	onDeny,
	onApprove,
}: {
	canAlwaysAllow: boolean;
	always: boolean;
	onAlwaysChange: (always: boolean) => void;
	/** What "always" covers, said out loud where the label is short. */
	alwaysOf: string;
	pending: boolean;
	error: Error | null;
	onDeny: () => void;
	onApprove: () => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				{canAlwaysAllow && (
					<label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
						<input
							type="checkbox"
							checked={always}
							onChange={(event) => onAlwaysChange(event.target.checked)}
							className="focus-ring size-3.5 shrink-0 cursor-pointer accent-primary"
						/>
						Always allow<span className="sr-only"> {alwaysOf}</span>
					</label>
				)}
				<div className="ml-auto flex gap-2">
					<Button variant="outline" size="sm" disabled={pending} onClick={onDeny}>
						Deny
					</Button>
					<Button size="sm" disabled={pending} onClick={onApprove}>
						Approve
					</Button>
				</div>
			</div>
			{error && (
				<p role="alert" className="m-0 text-destructive text-xs">
					{failureMessage(error)}
				</p>
			)}
		</div>
	);
}

/** How long the run has been stopped: `4s`, then `3m`, which is all a glance needs. */
function formatWaiting(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

/** The card shows at most this many of a request's fields; the full request has every one. */
const FIELDS_SHOWN = 6;

type Fields = [string, unknown][];

/** A value's named fields in order, or nothing when it is not a record of them. */
function fieldsOf(value: unknown): Fields | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const fields = Object.entries(value);
	return fields.length > 0 ? fields : undefined;
}

/** A list with nothing structured in it, which reads well enough as its items in a row. */
function isPlainList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.every((item) => item === null || typeof item !== "object");
}

function count(amount: number, one: string, many: string): string {
	return `${amount} ${amount === 1 ? one : many}`;
}

/**
 * A value as the card says it: text as itself, a list of plain values as those
 * values, and anything with structure inside as a count of what it holds,
 * which the full request spells out.
 */
function briefly(value: unknown): { text: string; counted: boolean } {
	if (typeof value === "string") return { text: value, counted: false };
	if (isPlainList(value)) return { text: value.map(String).join(", "), counted: false };
	if (Array.isArray(value)) return { text: count(value.length, "item", "items"), counted: true };
	if (value !== null && typeof value === "object") {
		return { text: count(Object.keys(value).length, "field", "fields"), counted: true };
	}
	return { text: String(value), counted: false };
}

/** A list of records previews this many of its entries on the card. */
const ENTRIES_PREVIEWED = 3;

/**
 * What the tool would be sent, in brief: the first few fields named in words,
 * each value folded to a few lines, or the first few entries of a list. What
 * is left out is counted; the whole of it is behind the card's expand button.
 */
function RequestSummary({ input }: { input: ToolCallPart["input"] }) {
	const fields = fieldsOf(input);
	if (fields) {
		const hidden = Math.max(fields.length - FIELDS_SHOWN, 0);
		return (
			<div className="flex flex-col gap-2">
				<dl className="m-0 grid w-full grid-cols-[fit-content(8rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
					{fields.slice(0, FIELDS_SHOWN).map(([key, value]) => (
						<div key={key} className="col-span-2 grid grid-cols-subgrid">
							<dt className="truncate text-muted-foreground text-xs">{wordsFromKey(key)}</dt>
							<dd className="m-0 min-w-0">
								<BriefValue value={value} />
							</dd>
						</div>
					))}
				</dl>
				{hidden > 0 && <Remainder>{count(hidden, "more field", "more fields")}</Remainder>}
			</div>
		);
	}
	if (isRecordList(input)) {
		const hidden = Math.max(input.length - ENTRIES_PREVIEWED, 0);
		return (
			<div className="flex flex-col items-start gap-2">
				<Entries entries={input.slice(0, ENTRIES_PREVIEWED)} depth={1} />
				{hidden > 0 && <Remainder>{`${hidden} more`}</Remainder>}
			</div>
		);
	}
	return (
		<p className="m-0">
			<BriefValue value={input} />
		</p>
	);
}

/** What the brief leaves out, counted, set in line with the values above it. */
function Remainder({ children }: { children: ReactNode }) {
	return <p className="m-0 text-muted-foreground text-xs">{children}</p>;
}

/** A non-empty list with records or lists in it, as opposed to plain values. */
function isRecordList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && !isPlainList(value);
}

/** A value in brief, folded to its first three lines. */
function BriefValue({ value }: { value: unknown }) {
	const { text, counted } = briefly(value);
	return (
		<span
			className={`line-clamp-3 whitespace-pre-wrap break-words text-sm ${
				counted ? "text-muted-foreground" : "text-foreground"
			}`}
		>
			{text}
		</span>
	);
}

/**
 * The whole request, for when the brief is not enough to judge it: the same
 * step as the card, with who asks folded into the line under it, every field laid out as fields all the way down,
 * and the answer, so it can be given without going back to the card. It
 * scrolls inside the dialog, so a request of any size never stretches the
 * thread.
 */
function RequestDialog({
	input,
	agent,
	wants,
	look,
	label,
	where,
	answer,
	open,
	onOpenChange,
}: {
	input: ToolCallPart["input"];
	agent: Asker;
	wants: string;
	look?: ConnectionLook;
	label: string;
	where: string;
	answer: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const headingId = useId();
	// Opening puts focus on the header, so the request starts from its top
	// rather than scrolled to its first control.
	const top = useRef<HTMLElement>(null);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				initialFocus={top}
				aria-labelledby={headingId}
				className="agent-tint flex max-h-[min(38rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-[36rem]"
				style={{ ["--agent-hue" as string]: agent.hue }}
			>
				<header
					ref={top}
					tabIndex={-1}
					className="border-border-subtle border-b px-4 pt-4 pb-3 outline-none"
				>
					<StepHeading
						look={look}
						label={label}
						where={where}
						detail={`${agent.name} ${wants}${where ? ` in ${where}` : ""}`}
						headingId={headingId}
					/>
				</header>
				<ScrollArea className="min-h-0 flex-1">
					<div className="px-4 py-3">
						<RequestValue value={input} depth={0} />
					</div>
				</ScrollArea>
				<footer className="flex flex-wrap items-start gap-2 border-border-subtle border-t px-4 py-3">
					<CopyJson value={input} />
					<div className="ml-auto min-w-0 flex-1">{answer}</div>
				</footer>
			</DialogContent>
		</Dialog>
	);
}

/** Past this depth a value is written as JSON rather than nested any further. */
const MAX_DEPTH = 3;

/** A long list shows this many entries until asked for the rest. */
const ENTRIES_SHOWN = 10;

/**
 * A value laid out for reading: a record as its fields, a list of records as
 * numbered entries, anything too deep to lay out as indented JSON.
 */
function RequestValue({ value, depth }: { value: unknown; depth: number }) {
	const fields = fieldsOf(value);
	if (fields && depth < MAX_DEPTH) return <FieldList fields={fields} depth={depth} />;
	if (isRecordList(value) && depth < MAX_DEPTH) return <EntryList entries={value} depth={depth} />;
	if (value !== null && typeof value === "object" && !isPlainList(value)) {
		return (
			<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-sunken px-2.5 py-2 font-mono text-2xs text-foreground">
				{JSON.stringify(value, null, 2)}
			</pre>
		);
	}
	return <PlainValue value={value} />;
}

/**
 * A record's fields, named in words. A field holding more structure puts it
 * under its name, indented along a guide line, rather than beside it.
 */
function FieldList({ fields, depth }: { fields: Fields; depth: number }) {
	return (
		<dl className="m-0 grid grid-cols-[fit-content(9rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
			{fields.map(([key, value]) => {
				const nested = hasStructure(value);
				return (
					<div key={key} className="col-span-2 grid grid-cols-subgrid">
						<dt className="truncate text-muted-foreground text-xs leading-5">
							{wordsFromKey(key)}
						</dt>
						{nested ? (
							<dd className="col-span-2 m-0 min-w-0">
								{Array.isArray(value) && (
									<span className="sr-only">{count(value.length, "entry", "entries")}</span>
								)}
								<div className="mt-1 ml-1 border-border-subtle border-l pl-3">
									<RequestValue value={value} depth={depth + 1} />
								</div>
							</dd>
						) : (
							<dd className="m-0 min-w-0">
								<PlainValue value={value} />
							</dd>
						)}
					</div>
				);
			})}
		</dl>
	);
}

/** Whether a value has fields or records inside, and so is laid out under its name. */
function hasStructure(value: unknown): boolean {
	return isRecordList(value) || fieldsOf(value) !== undefined;
}

/** A list of records, the first few until asked for the rest. */
function EntryList({ entries, depth }: { entries: unknown[]; depth: number }) {
	const [showAll, setShowAll] = useState(false);
	return (
		<div className="flex flex-col items-start gap-2">
			<Entries entries={showAll ? entries : entries.slice(0, ENTRIES_SHOWN)} depth={depth} />
			{entries.length > ENTRIES_SHOWN && (
				<button
					type="button"
					onClick={() => setShowAll((was) => !was)}
					className="focus-ring ml-7 cursor-pointer rounded-md font-semibold text-primary text-xs"
				>
					{showAll ? "Show fewer" : `Show all ${entries.length}`}
				</button>
			)}
		</div>
	);
}

/**
 * Records as numbered entries. Records that all share the same few fields are
 * a table, so those fields are named once rather than on every entry.
 */
function Entries({ entries, depth }: { entries: unknown[]; depth: number }) {
	const columns = sharedColumnsOf(entries);
	if (columns) return <EntryTable columns={columns} rows={entries as Record<string, unknown>[]} />;
	return (
		<ol className="m-0 flex w-full list-none flex-col gap-2 p-0">
			{entries.map((entry, index) => (
				// Entries have no identity of their own beyond where they sit.
				// biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
				<li key={index} className="flex gap-2.5">
					<EntryNumber>{index + 1}</EntryNumber>
					<div className="min-w-0 flex-1">
						{isSmallRecord(entry) ? (
							<SmallRecord fields={entry} />
						) : (
							<RequestValue value={entry} depth={depth + 1} />
						)}
					</div>
				</li>
			))}
		</ol>
	);
}

/** The fields every entry has, in the same order, when they are few and flat enough for a table. */
function sharedColumnsOf(entries: unknown[]): string[] | undefined {
	const [first] = entries;
	if (!isSmallRecord(first)) return undefined;
	const columns = Object.keys(first);
	const shared = entries.every(
		(entry) =>
			isSmallRecord(entry) &&
			Object.keys(entry).length === columns.length &&
			columns.every((column) => column in entry),
	);
	return shared ? columns : undefined;
}

function EntryTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
	return (
		<table className="border-collapse">
			<thead>
				<tr>
					<th scope="col" className="w-7 p-0">
						<span className="sr-only">Number</span>
					</th>
					{columns.map((column) => (
						<th
							key={column}
							scope="col"
							className="pr-4 pb-1 text-left font-normal text-muted-foreground text-xs"
						>
							{wordsFromKey(column)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are where they sit, and never reorder
					<tr key={index}>
						<td className="py-1 pr-2.5 align-baseline">
							<EntryNumber>{index + 1}</EntryNumber>
						</td>
						{columns.map((column) => (
							<td key={column} className="py-1 pr-4 align-baseline">
								<PlainValue value={row[column]} />
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function EntryNumber({ children }: { children: ReactNode }) {
	return (
		<span className="block w-5 shrink-0 text-right font-mono text-2xs text-muted-foreground leading-5">
			{children}
		</span>
	);
}

/** A record this small and flat reads best on one line, which is most list entries. */
const SMALL_RECORD_FIELDS = 4;

function isSmallRecord(value: unknown): value is Record<string, unknown> {
	const fields = fieldsOf(value);
	return (
		fields !== undefined &&
		fields.length <= SMALL_RECORD_FIELDS &&
		fields.every(([, field]) => !hasStructure(field))
	);
}

/** A small flat record on one line: each field's name, then its value. */
function SmallRecord({ fields }: { fields: Record<string, unknown> }) {
	return (
		<p className="m-0 leading-5">
			{Object.entries(fields).map(([key, value], index) => (
				<Fragment key={key}>
					{index > 0 && <span className="text-muted-foreground text-sm"> · </span>}
					<span className="text-muted-foreground text-xs">{wordsFromKey(key)}</span>{" "}
					<PlainValue value={value} />
				</Fragment>
			))}
		</p>
	);
}

/**
 * A single value as text: words as written, numbers in even figures, and
 * true, false and emptiness in a quieter voice, since they are flags rather
 * than content.
 */
function PlainValue({ value }: { value: unknown }) {
	if (isPlainList(value)) {
		if (value.length === 0) return <Quiet>None</Quiet>;
		return <span className="text-foreground text-sm">{value.map(String).join(", ")}</span>;
	}
	if (value === null || value === undefined || value === "") return <Quiet>Empty</Quiet>;
	if (typeof value === "boolean") return <Quiet>{value ? "Yes" : "No"}</Quiet>;
	if (typeof value === "number") {
		return <span className="text-foreground text-sm tabular-nums">{value}</span>;
	}
	if (fieldsOf(value) === undefined && typeof value === "object") return <Quiet>None</Quiet>;
	return (
		<span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground text-sm">
			{String(value)}
		</span>
	);
}

function Quiet({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground text-sm">{children}</span>;
}

/** The request exactly as the tool would receive it, for anyone who needs the payload itself. */
function CopyJson({ value }: { value: unknown }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => {
				void navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
				setCopied(true);
			}}
		>
			{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			{copied ? "Copied" : "Copy JSON"}
		</Button>
	);
}

/**
 * What a refusal leaves behind. An approved write folds away into the log with
 * everything else the turn did; a denied one stays, because it changed what
 * the reply was able to do and the thread would otherwise not say so. Review
 * opens the request that was refused, as it was put, with who refused it where
 * the answer was.
 */
export function DeniedToolLine({
	call,
	agent,
	look,
}: {
	call: ToolCallPart;
	/** The agent whose request this was. */
	agent: Asker;
	look?: ConnectionLook;
}) {
	const [requestOpen, setRequestOpen] = useState(false);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, look?.name) : "";
	const label = stepLabel(call.tool, name);
	const by = call.approval?.decidedByName;
	const denied = by ? `${by} denied` : "Denied";
	return (
		<div className="flex items-center gap-2 pr-8 pl-3.5 text-muted-foreground text-xs">
			{/* As on the typing line: the service is its mark, and its name is said out loud only. */}
			<span className="flex min-w-0 flex-1 items-center gap-1.5">
				<span className="shrink-0">{denied}</span>
				{where && (
					<ConnectionMark presetId={look?.presetId} name={where} hue={look?.hue ?? 250} size="xs" />
				)}
				<span className="min-w-0 truncate font-semibold text-foreground">
					{label}
					{where && <span className="sr-only"> in {where}</span>}
				</span>
			</span>
			<button
				type="button"
				onClick={() => setRequestOpen(true)}
				className="focus-ring shrink-0 cursor-pointer rounded-md px-1 font-semibold text-primary"
			>
				Review
			</button>
			<RequestDialog
				input={call.input}
				agent={agent}
				wants={call.mutating ? "wanted to make a change" : "wanted to use a tool"}
				look={look}
				label={label}
				where={where}
				answer={
					<p className="m-0 text-right text-muted-foreground text-sm leading-8">
						{by ? `Denied by ${by}` : "Denied"}
					</p>
				}
				open={requestOpen}
				onOpenChange={setRequestOpen}
			/>
		</div>
	);
}
