import { botColorVariables } from "@sugabots/avatars";
import type { ThreadParticipant, ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronDown, Globe, X } from "lucide-react";
import { Fragment, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { awaitedDeciders } from "@/lib/tool-approvals.ts";
import {
	connectionLabel,
	NETWORK_REQUEST_TOOL,
	splitToolKey,
	stepLabel,
	wordsFromKey,
} from "@/lib/tool-names.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Dialog, DialogClose, DialogContent } from "@/ui/dialog.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { awaitsApproval } from "./tool-activity.ts";

/*
 * A write a bot wants to make, held for someone to allow or deny, and what
 * became of it once they did. It sits under the bot's words on a raised card,
 * tucked toward them, and says what it is asking before anyone answers: who
 * wants to use what, then the request itself.
 *
 * On a wide screen the request is in the card, folded once it runs long, and
 * is answered there. On a phone the card shows the start of it and opens the
 * whole request full screen, with the answer pinned under it, so a long
 * request is read as a page rather than in a box inside the chat.
 */

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;
type Asker = Pick<AgentParticipant, "name" | "color" | "face">;
type Decision = "allow_once" | "deny";

export function ToolApprovalCard({
	call,
	agent,
	threadId,
	podId,
	canApprove,
	look,
}: {
	call: ToolCallPart;
	/** The bot whose reply is waiting on this. */
	agent: Asker;
	threadId: string;
	podId: string;
	/** Whether the reader may answer it. */
	canApprove: boolean;
	look?: ConnectionLook;
}) {
	const review = useReviewToolCall(threadId, podId);
	const [reviewing, setReviewing] = useState(false);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, look?.name) : "";
	const action = stepLabel(call.tool, name);
	const networkRequest = call.tool === NETWORK_REQUEST_TOOL;
	const step: Step = {
		action,
		who: networkRequest
			? `${agent.name} wants its sandbox to reach a new host`
			: `${agent.name} wants to use ${where || "a tool"}`,
		where,
		look,
		networkRequest,
	};
	const answerable = awaitsApproval(call) && canApprove;
	// The answer stays given from when it is sent until the thread's events say
	// the call is decided, a moment after the decision is accepted.
	const sent = review.isPending || review.isSuccess;
	const decide = (decision: Decision) =>
		review.mutate({ toolCallId: call.id, decision }, { onSuccess: () => setReviewing(false) });
	const decided = call.approval;
	// Only an answer given here is announced; one already in the history is just read.
	const announced = review.isSuccess;
	const status =
		awaitsApproval(call) && !canApprove ? (
			<p className="m-0 text-pretty text-muted-foreground text-xs leading-normal">
				{awaitedDeciders(call)}
			</p>
		) : decided?.status === "allowed" ? (
			<Outcome announced={announced} icon={<Check aria-hidden size={12} strokeWidth={2.8} />}>
				Allowed{decided.decidedByName && ` by ${decided.decidedByName}`}
			</Outcome>
		) : decided?.status === "denied" ? (
			<Outcome announced={announced} icon={<X aria-hidden size={12} strokeWidth={2.8} />}>
				Denied{decided.decidedByName && ` by ${decided.decidedByName}`}. {agent.name} won't go
				ahead.
			</Outcome>
		) : null;

	return (
		<section
			aria-label={`Approval request: ${where ? `${action} in ${where}` : action}`}
			className="flex animate-rise motion-reduce:animate-none"
		>
			<div className="flex min-w-0 max-w-[460px] flex-1 flex-col gap-2.5 rounded-[6px_20px_20px_20px] bg-card pt-2.5 pr-3 pb-3 pl-2.5 text-foreground">
				<StepHeading step={step} />
				<div className="min-w-0 md:ml-[34px]">
					<FoldedRequest input={call.input} />
				</div>
				<div
					className={cn(
						"flex min-w-0 flex-col gap-2 md:ml-[34px]",
						// On a wide screen an answered request has nothing here; only a phone's See request is.
						!answerable && !status && "md:hidden",
					)}
				>
					{status}
					{answerable && (
						<div className="max-md:hidden">
							<Answer pending={sent} error={review.error} onDecide={decide} actionLabel={action} />
						</div>
					)}
					<div className="md:hidden">
						{answerable ? (
							<Button className="h-11 w-full text-[15px]" onClick={() => setReviewing(true)}>
								Review
							</Button>
						) : (
							<Button
								variant="secondary"
								className="h-11 w-full text-[15px]"
								onClick={() => setReviewing(true)}
							>
								See request
							</Button>
						)}
					</div>
				</div>
			</div>
			<ReviewSheet
				input={call.input}
				step={step}
				open={reviewing}
				onOpenChange={setReviewing}
				agent={agent}
			>
				{answerable ? (
					<Answer
						pending={sent}
						error={review.error}
						onDecide={decide}
						actionLabel={action}
						pinned
					/>
				) : (
					status
				)}
			</ReviewSheet>
		</section>
	);
}

/**
 * What became of an answered request, with a mark for which way it went.
 * `announced` makes it a live region, for an answer the reader just gave.
 */
function Outcome({
	announced,
	icon,
	children,
}: {
	announced: boolean;
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<p
			role={announced ? "status" : undefined}
			className="m-0 flex items-start gap-1.5 text-muted-foreground text-xs leading-normal"
		>
			<span className="mt-[3px] flex shrink-0">{icon}</span>
			<span>{children}</span>
		</p>
	);
}

/** What a card says it is asking, in its header and the full-screen request's. */
interface Step {
	action: string;
	who: string;
	where: string;
	look: ConnectionLook | undefined;
	/** A request for the sandbox to reach another host, which no connection makes. */
	networkRequest: boolean;
}

const MARK_SIZES = {
	md: { box: "size-6 rounded-[7px]", icon: 14 },
	sm: { box: "size-8 rounded-lg", icon: 16 },
} as const;

/** What the step uses: the connection's mark, or a globe for a network request. */
function StepMark({ step, size }: { step: Step; size: keyof typeof MARK_SIZES }) {
	if (!step.networkRequest) {
		return (
			<ConnectionMark presetId={step.look?.presetId} name={step.where || step.action} size={size} />
		);
	}
	const { box, icon } = MARK_SIZES[size];
	return (
		<span
			aria-hidden
			className={cn("grid shrink-0 place-items-center bg-border-strong text-foreground", box)}
		>
			<Globe size={icon} strokeWidth={2} />
		</span>
	);
}

/** The connection's mark beside who wants to use it, and what they would do. */
function StepHeading({ step }: { step: Step }) {
	return (
		<div className="flex min-w-0 items-start gap-2.5">
			<span className="mt-px">
				<StepMark step={step} size="md" />
			</span>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-muted-foreground text-xs leading-[1.4]">{step.who}</span>
				<span className="text-pretty font-medium text-[14px] leading-[1.4] [overflow-wrap:anywhere]">
					{step.action}
				</span>
			</span>
		</div>
	);
}

/** How tall a folded request stands: about three of its rows. */
const FOLDED_HEIGHT_PX = 66;

/**
 * The request on its hairline rule. Past about three rows it folds, fading
 * out; unfolded it scrolls inside the card past a cap, and stops at its ends
 * rather than handing the scroll to the chat. On a phone a long one is only
 * ever its folded start, since the whole of it opens full screen.
 */
function FoldedRequest({ input }: { input: ToolCallPart["input"] }) {
	const bodyId = useId();
	const content = useRef<HTMLDivElement>(null);
	const [foldable, setFoldable] = useState(false);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		const element = content.current;
		if (!element) return;
		const measure = () => setFoldable(element.scrollHeight > FOLDED_HEIGHT_PX);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const folded = foldable && !open;
	return (
		<div className="flex min-w-0 flex-col items-start gap-1">
			<div
				id={bodyId}
				// Unfolded, it scrolls, so a keyboard needs to reach it.
				tabIndex={foldable && open ? 0 : undefined}
				className={cn(
					"focus-ring w-full min-w-0 border-border-dashed border-l-2 pl-2.5",
					foldable && FOLDED_CLASSES_ON_PHONE,
					folded && FOLDED_CLASSES,
					foldable &&
						open &&
						"md:max-h-[min(168px,40vh)] md:overflow-y-auto md:overscroll-contain md:pr-1.5 md:[scrollbar-width:thin]",
				)}
			>
				<div ref={content}>
					<RequestValue value={input} depth={0} />
				</div>
			</div>
			{foldable && (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen(!open)}
					className="focus-ring flex cursor-pointer items-center gap-[5px] rounded-md py-1.5 font-medium text-link text-xs max-md:hidden"
				>
					{open ? "See less" : "See more"}
					<ChevronDown
						aria-hidden
						className={cn("size-3 transition-transform", open && "rotate-180")}
						strokeWidth={3}
					/>
				</button>
			)}
		</div>
	);
}

const FOLDED_CLASSES =
	"max-h-[66px] overflow-hidden [mask-image:linear-gradient(#000_55%,transparent)]";
const FOLDED_CLASSES_ON_PHONE =
	"max-md:max-h-[66px] max-md:overflow-hidden max-md:[mask-image:linear-gradient(#000_55%,transparent)]";

/**
 * The whole request on a phone, full screen: what is asked at the top, every
 * field under it scrolling with the page, and the answer pinned along the
 * foot where a thumb reaches it. Closing it changes nothing; answering closes
 * it.
 */
function ReviewSheet({
	input,
	step,
	open,
	onOpenChange,
	agent,
	children,
}: {
	input: ToolCallPart["input"];
	step: Step;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The bot asking, whose face heads the request. */
	agent: Asker;
	/** The answer, or what became of the request. */
	children: ReactNode;
}) {
	const headingId = useId();
	// Opening puts focus on the top of the request rather than on Close, so it
	// is read from the start.
	const top = useRef<HTMLDivElement>(null);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				initialFocus={top}
				aria-labelledby={headingId}
				style={botColorVariables(agent.color)}
				className="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-none md:inset-auto md:top-1/2 md:left-1/2 md:h-auto md:max-h-[min(38rem,calc(100dvh-4rem))] md:max-w-[36rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-dialog"
			>
				<div
					ref={top}
					tabIndex={-1}
					className="flex shrink-0 justify-end px-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] outline-none"
				>
					<DialogClose
						aria-label="Close"
						className="focus-ring grid size-8 place-items-center rounded-full bg-chip text-soft-foreground transition-colors hover:bg-hover"
					>
						<X aria-hidden size={15} strokeWidth={2.4} />
					</DialogClose>
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-4 px-4 py-4">
						<ReviewHeading step={step} agent={agent} headingId={headingId} />
						<RequestValue value={input} depth={0} />
					</div>
				</ScrollArea>
				<footer className="shrink-0 border-border-subtle border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
					{children}
				</footer>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The top of the full-screen request: the asking bot's face with the app's
 * mark on its corner, what it would do as the heading, and who wants to use
 * what under it.
 */
function ReviewHeading({
	step,
	agent,
	headingId,
}: {
	step: Step;
	agent: Asker;
	headingId: string;
}) {
	return (
		<div className="flex flex-col items-center gap-1 pb-2 text-center">
			<span aria-hidden className="relative mb-2.5 inline-flex">
				<AgentAvatar color={agent.color} face={agent.face} size={64} />
				<span className="absolute -right-2 -bottom-1 rounded-[10px] ring-[3px] ring-panel">
					<StepMark step={step} size="sm" />
				</span>
			</span>
			<h2
				id={headingId}
				className="m-0 text-balance font-bold text-[20px] text-foreground leading-tight [overflow-wrap:anywhere]"
			>
				{step.action}
			</h2>
			<p className="m-0 text-pretty text-[14px] text-muted-foreground">{step.who}</p>
		</div>
	);
}

/**
 * Allow and Deny, and what went wrong if answering failed. Deny is neutral:
 * refusing is not a danger. Pinned along a phone's foot they are two halves,
 * Deny first, so Allow is under the thumb.
 */
export function Answer({
	pending,
	error,
	onDecide,
	actionLabel,
	pinned = false,
}: {
	pending: boolean;
	error: Error | null;
	onDecide: (decision: Decision) => void;
	/** What would be allowed, for Allow's accessible name. */
	actionLabel: string;
	pinned?: boolean;
}) {
	const allow = (
		<Button
			disabled={pending}
			onClick={() => onDecide("allow_once")}
			aria-label={`Allow: ${actionLabel}`}
			className={pinned ? "h-11 flex-1 text-[15px]" : "h-[31px] px-4 text-[13px]"}
		>
			Allow
		</Button>
	);
	const deny = (
		<Button
			variant="muted"
			disabled={pending}
			onClick={() => onDecide("deny")}
			aria-label={`Deny: ${actionLabel}`}
			className={pinned ? "h-11 flex-1 text-[15px]" : "h-[31px] px-4 text-[13px]"}
		>
			Deny
		</Button>
	);
	return (
		<div className="flex flex-col gap-1.5">
			<fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
				<legend className="sr-only">Answer this request</legend>
				{pinned ? (
					<>
						{deny}
						{allow}
					</>
				) : (
					<>
						{allow}
						{deny}
					</>
				)}
			</fieldset>
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
export function fieldsOf(value: unknown): Fields | undefined {
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

/** Past this depth a value is written as JSON rather than nested any further. */
const MAX_DEPTH = 3;

/** A long list shows this many entries until asked for the rest. */
const ENTRIES_SHOWN = 10;

/**
 * A value laid out for reading: a record as its fields, a list of records as
 * numbered entries, anything too deep to lay out as indented JSON.
 */
export function RequestValue({ value, depth }: { value: unknown; depth: number }) {
	const fields = fieldsOf(value);
	if (fields && depth < MAX_DEPTH) return <FieldList fields={fields} depth={depth} />;
	if (isRecordList(value) && depth < MAX_DEPTH) return <EntryList entries={value} depth={depth} />;
	if (value !== null && typeof value === "object" && !isPlainList(value)) {
		return (
			<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-list px-2.5 py-2 font-mono text-2xs">
				{JSON.stringify(value, null, 2)}
			</pre>
		);
	}
	return <PlainValue value={value} />;
}

/**
 * A record's fields, named in words: each name beside its value on a wide
 * screen, and above it on a phone, where a row is too narrow for both. A
 * field holding more structure puts it under its name, indented along a guide
 * line, rather than beside it.
 */
function FieldList({ fields, depth }: { fields: Fields; depth: number }) {
	return (
		<dl className="m-0 flex flex-col gap-3 md:grid md:grid-cols-[fit-content(min(180px,40%))_minmax(0,1fr)] md:gap-x-2.5 md:gap-y-0.5">
			{fields.map(([key, value]) => {
				const nested = hasStructure(value);
				return (
					<div
						key={key}
						className="flex min-w-0 flex-col gap-0.5 md:col-span-2 md:grid md:grid-cols-subgrid md:gap-0"
					>
						<dt className="text-[14px] text-muted-foreground leading-normal md:min-w-[76px]">
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
							className="pr-4 pb-1 text-left font-normal text-[14px] text-muted-foreground"
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
					{index > 0 && <span className="text-[14px] text-muted-foreground">, </span>}
					<span className="text-[14px] text-muted-foreground">{wordsFromKey(key)}</span>{" "}
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
		return <span className="text-[14px] leading-normal">{value.map(String).join(", ")}</span>;
	}
	if (value === null || value === undefined || value === "") return <Quiet>Empty</Quiet>;
	if (typeof value === "boolean") return <Quiet>{value ? "Yes" : "No"}</Quiet>;
	if (typeof value === "number") {
		return <span className="text-[14px] tabular-nums leading-normal">{value}</span>;
	}
	if (fieldsOf(value) === undefined && typeof value === "object") return <Quiet>None</Quiet>;
	return (
		<span className="whitespace-pre-wrap text-pretty text-[14px] leading-normal [overflow-wrap:anywhere]">
			{String(value)}
		</span>
	);
}

function Quiet({ children }: { children: ReactNode }) {
	return <span className="text-[14px] text-muted-foreground leading-normal">{children}</span>;
}
