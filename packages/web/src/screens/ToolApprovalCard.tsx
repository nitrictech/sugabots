import { botColorVariables } from "@sugabots/avatars";
import type { ThreadParticipant, ToolCallPart } from "@sugabots/contracts";
import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { connectionLabel, splitToolKey, stepLabel, wordsFromKey } from "@/lib/tool-names.ts";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Dialog, DialogContent } from "@/ui/dialog.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";

/*
 * A write a bot wants to make, and its reply stopped until someone answers:
 * what it would do and where, then Allow or Deny. It sits among the bot's
 * bubbles in the bot's tint, tucked under the message above it. The tool's
 * name opens the whole request, laid out as fields, where it can be answered
 * too.
 */

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

type Asker = Pick<AgentParticipant, "name" | "color" | "face">;

export function ToolApprovalCard({
	call,
	agent,
	threadId,
	podId,
	canApprove,
	look,
	answerPinned = false,
	outgoing = false,
}: {
	call: ToolCallPart;
	/** The bot whose reply is waiting on this. */
	agent: Asker;
	threadId: string;
	podId: string;
	canApprove: boolean;
	look?: ConnectionLook;
	/** Whether, on a phone, Allow and Deny are pinned below instead, as `PinnedApproval`. */
	answerPinned?: boolean;
	/** Whether the asking bot's messages sit on the right, so the card sits under them there. */
	outgoing?: boolean;
}) {
	const review = useReviewToolCall(threadId, podId);
	// This goes when the thread's events say the call is decided, a moment
	// after the decision is accepted; until then the answer stays given.
	const sent = review.isPending || review.isSuccess;
	const [requestOpen, setRequestOpen] = useState(false);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, look?.name) : "";
	const label = stepLabel(call.tool, name);
	const title = where ? `${label} in ${where}` : label;
	const wants = call.mutating ? "wants to make a change" : "wants to use a tool";
	// One answer, drawn on the card and again in the full request.
	const answer = canApprove ? (
		<Answer
			pending={sent}
			error={review.error}
			onDeny={() => review.mutate({ toolCallId: call.id, decision: "deny" })}
			onAllow={() => review.mutate({ toolCallId: call.id, decision: "allow_once" })}
		/>
	) : (
		<p className="m-0 text-muted-foreground text-xs">
			Waiting for someone with permission to answer this.
		</p>
	);
	return (
		<section
			aria-label={`Approval needed: ${title}`}
			className={`flex animate-rise motion-reduce:animate-none ${outgoing ? "justify-end pr-[42px]" : "pl-[42px]"}`}
			style={botColorVariables(agent.color)}
		>
			<div
				className={`inline-flex max-w-full flex-col items-start gap-1 bg-bot-tint py-[9px] pr-3 pl-2.5 text-bot-text ${outgoing ? "rounded-[20px_6px_20px_20px]" : "rounded-[6px_20px_20px_20px]"}`}
			>
				<span className="flex min-w-0 items-center gap-2.5">
					<ConnectionMark presetId={look?.presetId} name={where || label} size="md" />
					<button
						type="button"
						onClick={() => setRequestOpen(true)}
						aria-label={`View the full request: ${title}`}
						className="focus-ring min-w-0 rounded-md text-left font-medium text-[14px] hover:underline"
					>
						{label}
						{where && <span className="font-normal text-muted-foreground"> in {where}</span>}
					</button>
				</span>
				<div className={`mt-1 mb-0.5 ml-[34px] ${answerPinned ? "max-md:hidden" : ""}`}>
					{answer}
				</div>
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

/**
 * Allow and Deny for the first call waiting on an answer, full width along the
 * foot of a phone's collaboration sheet, where a thumb reaches them. The card
 * in the thread still says what is being asked.
 */
export function PinnedApproval({
	call,
	threadId,
	podId,
	canApprove,
}: {
	call: ToolCallPart;
	threadId: string;
	podId: string;
	canApprove: boolean;
}) {
	const review = useReviewToolCall(threadId, podId);
	// This goes when the thread's events say the call is decided, a moment
	// after the decision is accepted; until then the answer stays given.
	const sent = review.isPending || review.isSuccess;
	const label = stepLabel(call.tool, splitToolKey(call.tool).name);
	if (!canApprove) {
		return (
			<p className="m-0 px-4 pt-2 pb-4 text-center text-muted-foreground text-sm">
				Waiting for someone with permission to answer this.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2 px-4 pt-2 pb-4">
			<div className="grid grid-cols-2 gap-2.5">
				<Button
					size="lg"
					variant="secondary"
					disabled={sent}
					aria-label={`Deny: ${label}`}
					onClick={() => review.mutate({ toolCallId: call.id, decision: "deny" })}
					className="bg-border-strong hover:bg-person-avatar"
				>
					Deny
				</Button>
				<Button
					size="lg"
					disabled={sent}
					aria-label={`Allow: ${label}`}
					onClick={() => review.mutate({ toolCallId: call.id, decision: "allow_once" })}
				>
					Allow
				</Button>
			</div>
			{review.error && (
				<p role="alert" className="m-0 text-center text-destructive-text text-xs">
					{failureMessage(review.error)}
				</p>
			)}
		</div>
	);
}

/** The connection's logo beside what the step does, and a line under it: where, unless told otherwise. */
function StepHeading({
	look,
	label,
	where,
	detail = where,
	headingId,
}: {
	look?: ConnectionLook;
	label: string;
	where: string;
	detail?: string;
	/** Set where the heading names a surface, as the full request's does. */
	headingId?: string;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<ConnectionMark presetId={look?.presetId} name={where || label} size="sm" />
			<span className="flex min-w-0 flex-col">
				<span id={headingId} className="font-semibold text-base text-foreground">
					{label}
				</span>
				{detail && <span className="text-muted-foreground text-xs">{detail}</span>}
			</span>
		</div>
	);
}

/** Allow and Deny, and what went wrong if answering failed. Deny is neutral: refusing is not a danger. */
function Answer({
	pending,
	error,
	onDeny,
	onAllow,
}: {
	pending: boolean;
	error: Error | null;
	onDeny: () => void;
	onAllow: () => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex gap-1.5">
				<Button size="sm" disabled={pending} onClick={onAllow}>
					Allow
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={pending}
					onClick={onDeny}
					className="bg-border-strong hover:bg-person-avatar"
				>
					Deny
				</Button>
			</div>
			{error && (
				<p role="alert" className="m-0 text-destructive-text text-xs">
					{failureMessage(error)}
				</p>
			)}
		</div>
	);
}

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

/** A list with records in it, which is laid out as entries rather than in a row. */
function isRecordList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && !isPlainList(value);
}

/**
 * The whole request, to judge it by: the same step as the card, with who asks
 * folded into the line under it, every field laid out as fields all the way down,
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
				className="flex max-h-[min(38rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-[36rem]"
				style={botColorVariables(agent.color)}
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
			<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-list px-2.5 py-2 font-mono text-2xs text-foreground">
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
					className="focus-ring ml-7 cursor-pointer rounded-md font-semibold text-link text-xs"
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
