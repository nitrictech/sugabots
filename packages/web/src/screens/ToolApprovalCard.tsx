import { botColorVariables } from "@sugabots/avatars";
import type { BotParticipant, ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronDown, type LucideIcon, X } from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { hostRequestPresentation } from "@/lib/approval-tool-source.ts";
import { awaitedApprovers, closedApprovalMessage, routineChangeMessage } from "@/lib/approvals.ts";
import { useReviewToolCall } from "@/lib/chat-query.ts";
import { type MarkedConnector, useApprovalConnector } from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { formatCount } from "@/lib/name-list.ts";
import { connectorLabel, splitToolKey, stepLabel, wordsFromKey } from "@/lib/tool-names.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
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

type Asker = Pick<BotParticipant, "name" | "color" | "eyes" | "shape"> & { id?: string };
type Decision = "allow_once" | "deny";

export function ToolApprovalCard({
	call,
	bot,
	chatId,
	projectId,
	canApprove,
	connector: legacyConnector,
}: {
	call: ToolCallPart;
	/** The bot whose reply is waiting on this. */
	bot: Asker;
	chatId: string;
	projectId?: string | null | undefined;
	/** Whether the reader may answer it. */
	canApprove: boolean;
	connector?: MarkedConnector;
}) {
	const review = useReviewToolCall(chatId, call.approval?.id);
	const [reviewing, setReviewing] = useState(false);
	const answerable = awaitsApproval(call) && canApprove;
	const boundConnector = useApprovalConnector(call, projectId, bot.id, answerable);
	const connector = call.approval?.connector ? boundConnector : legacyConnector;
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectorLabel(handle, connector?.name) : "";
	const action = stepLabel(call.tool, name);
	const hostRequest = hostRequestPresentation(call.tool, bot.name);
	const step: Step = {
		action,
		who: hostRequest?.description ?? `${bot.name} wants to use ${where || "a tool"}`,
		where,
		connector,
		icon: hostRequest?.icon,
	};
	// The answer stays given from when it is sent until the chat's events say
	// the call is decided, a moment after the decision is accepted.
	const sent = review.isPending || review.isSuccess;
	const decide = (decision: Decision) =>
		review.mutate({ call, decision }, { onSuccess: () => setReviewing(false) });
	const decided = call.approval;
	// Only an answer given here is announced; one already in the history is just read.
	const announced = review.isSuccess;
	const status =
		awaitsApproval(call) && !canApprove ? (
			<p className="m-0 text-pretty text-muted-foreground text-xs leading-normal">
				{awaitedApprovers(call)}
			</p>
		) : decided?.status === "allowed" ? (
			<Outcome announced={announced} icon={<Check aria-hidden size={12} strokeWidth={2.8} />}>
				Allowed{decided.decidedByName && ` by ${decided.decidedByName}`}
			</Outcome>
		) : decided?.closedBecause ? (
			<p
				role={review.error ? "status" : undefined}
				className="m-0 text-pretty text-muted-foreground text-xs leading-normal"
			>
				{closedApprovalMessage(call, bot.name)}
			</p>
		) : decided?.status === "denied" ? (
			<Outcome announced={announced} icon={<X aria-hidden size={12} strokeWidth={2.8} />}>
				Denied{decided.decidedByName && ` by ${decided.decidedByName}`}. {bot.name} won't go ahead.
			</Outcome>
		) : null;

	return (
		<section
			aria-label={`Approval request: ${where ? `${action} in ${where}` : action}`}
			className="flex animate-rise motion-reduce:animate-none"
		>
			<div className="flex min-w-0 max-w-md flex-1 flex-col gap-2.5 rounded-bubble bg-card pt-2.5 pr-3 pb-3 pl-2.5 text-foreground">
				<StepHeading step={step} />
				<div className="min-w-0 md:ml-8">
					<ApprovalDestination
						botName={bot.name}
						browserUrl={call.approval?.browserUrl}
						gitHub={call.approval?.gitHub}
						briefDestination={call.approval?.briefDestination}
						routineChange={call.approval?.routineChange}
						routineTimeZone={call.approval?.routineTimeZone}
						connectorUrl={boundConnector?.url}
						connectorChanged={boundConnector?.changed}
						waiting={call.approval?.status === "pending"}
					/>
					<FoldedRequest input={call.input} />
				</div>
				<div
					className={cn(
						"flex min-w-0 flex-col gap-2 md:ml-8",
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
							<Button className={cn(TOUCH_BUTTON, "w-full")} onClick={() => setReviewing(true)}>
								Review
							</Button>
						) : (
							<Button
								variant="secondary"
								className={cn(TOUCH_BUTTON, "w-full")}
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
				browserUrl={call.approval?.browserUrl}
				gitHub={call.approval?.gitHub}
				briefDestination={call.approval?.briefDestination}
				routineChange={call.approval?.routineChange}
				routineTimeZone={call.approval?.routineTimeZone}
				connectorUrl={boundConnector?.url}
				connectorChanged={boundConnector?.changed}
				waiting={call.approval?.status === "pending"}
				step={step}
				open={reviewing}
				onOpenChange={setReviewing}
				bot={bot}
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

/** A button sized for a thumb, for the phone's Review and its pinned answer. */
const TOUCH_BUTTON = "h-11 text-sm";

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
			<span className="mt-0.5 flex shrink-0">{icon}</span>
			<span>{children}</span>
		</p>
	);
}

/** What a card says it is asking, in its header and the full-screen request's. */
interface Step {
	action: string;
	who: string;
	where: string;
	connector: MarkedConnector | undefined;
	icon: LucideIcon | undefined;
}

/** What the step uses: the connector's mark, or a globe for a host request. */
function StepMark({ step, size }: { step: Step; size: "md" | "sm" }) {
	return (
		<ConnectorMark
			markId={step.connector?.markId}
			name={step.where || step.action}
			icon={step.icon}
			size={size}
		/>
	);
}

/** The connector's mark beside who wants to use it, and what they would do. */
function StepHeading({ step }: { step: Step }) {
	return (
		<div className="flex min-w-0 items-start gap-2.5">
			<span className="mt-px">
				<StepMark step={step} size="md" />
			</span>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-muted-foreground text-xs leading-snug">{step.who}</span>
				<span className="text-pretty font-medium text-sm leading-snug wrap-anywhere">
					{step.action}
				</span>
			</span>
		</div>
	);
}

/** How tall a folded request stands: about three of its rows. */
const FOLDED_HEIGHT_PX = 66;

/** The folded classes cap the request at `--folded-height`, so it folds at the height it is measured against. */
const FOLDED_HEIGHT_VARIABLE = { "--folded-height": `${FOLDED_HEIGHT_PX}px` } as CSSProperties;

/**
 * The request on its hairline rule. Past about three rows it folds, fading
 * out; unfolded it scrolls inside the card past a cap, and stops at its ends
 * rather than handing the scroll to the chat. On a phone a long one is only
 * ever its folded start, since the whole of it opens full screen.
 */
export function FoldedRequest({ input }: { input: ToolCallPart["input"] }) {
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
				tabIndex={open ? 0 : undefined}
				style={FOLDED_HEIGHT_VARIABLE}
				className={cn(
					"focus-ring w-full min-w-0 border-border-dashed border-l-2 pl-2.5",
					foldable && FOLDED_CLASSES_ON_PHONE,
					folded && FOLDED_CLASSES,
					open &&
						"md:max-h-tool-input md:overflow-y-auto md:overscroll-contain md:pr-1.5 md:scrollbar-thin",
				)}
			>
				<div ref={content}>
					{open ? <ExactRequest input={input} /> : <RequestValue value={input} depth={0} />}
				</div>
			</div>
			<Button
				variant="link"
				size="text"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(!open)}
				className="gap-1 py-1.5 max-md:hidden"
			>
				{open ? "See less" : "See more"}
				<ChevronDown
					aria-hidden
					className={cn("size-3 transition-transform", open && "rotate-180")}
					strokeWidth={3}
				/>
			</Button>
		</div>
	);
}

type ApprovalGitHub = NonNullable<ToolCallPart["approval"]>["gitHub"];
type BriefDestination = NonNullable<ToolCallPart["approval"]>["briefDestination"];
type RoutineChange = NonNullable<ToolCallPart["approval"]>["routineChange"];

export function ApprovalDestination({
	botName,
	browserUrl,
	gitHub,
	briefDestination,
	routineChange,
	routineTimeZone,
	connectorUrl,
	connectorChanged,
	waiting,
}: {
	botName: string;
	browserUrl?: string | undefined;
	gitHub?: ApprovalGitHub | undefined;
	briefDestination?: BriefDestination;
	routineChange?: RoutineChange;
	routineTimeZone?: string | undefined;
	connectorUrl?: string | null | undefined;
	connectorChanged?: boolean | undefined;
	/** Whether the request still waits for an answer, which the browser note is about. */
	waiting?: boolean | undefined;
}) {
	if (waiting && connectorChanged) {
		return (
			<p className="m-0 pb-1.5 text-muted-foreground text-xs">
				This connector changed after {botName} asked. Choosing Allow closes this request and tells{" "}
				{botName} why. Ask {botName} to try again.
			</p>
		);
	}
	const address = browserUrl ?? connectorUrl;
	const gitHubLines = gitHub && (gitHub.baseBranch || gitHub.reviewCommit);
	const routineMessage = routineChangeMessage(routineChange);
	if (!address && !gitHubLines && !briefDestination && !routineMessage && !routineTimeZone)
		return null;
	return (
		<div className="space-y-1 pb-1.5 text-muted-foreground text-xs wrap-anywhere">
			{briefDestination && (
				<p className="m-0">
					Starts a chat with {briefDestination.botName} in{" "}
					{briefDestination.projectName ?? `${briefDestination.botName}'s own chats`}
				</p>
			)}
			{routineMessage && <p className="m-0">{routineMessage}</p>}
			{routineTimeZone && <p className="m-0">Runs in the {routineTimeZone} time zone.</p>}
			{address && (
				<p className="m-0">
					{browserUrl ? "On the page" : "Sends to"} {address}
				</p>
			)}
			{browserUrl && waiting && (
				<p className="m-0">
					Allowing this lets {botName} act anywhere on this page, which may change before you
					decide.
				</p>
			)}
			{gitHub?.baseBranch && <p className="m-0">Base branch {gitHub.baseBranch}</p>}
			{gitHub?.reviewCommit && (
				<p className="m-0">Reviews commit {gitHub.reviewCommit.slice(0, 7)}</p>
			)}
		</div>
	);
}

export function ExactRequest({ input }: { input: ToolCallPart["input"] }) {
	return (
		<pre className="m-0 whitespace-pre-wrap wrap-anywhere rounded-md bg-list px-2.5 py-2 font-mono text-xs">
			{JSON.stringify(input, null, 2)}
		</pre>
	);
}

const FOLDED_CLASSES = "max-h-(--folded-height) overflow-hidden mask-b-from-55%";
const FOLDED_CLASSES_ON_PHONE =
	"max-md:max-h-(--folded-height) max-md:overflow-hidden max-md:mask-b-from-55%";

/**
 * The whole request on a phone, full screen: what is asked at the top, every
 * field under it scrolling with the page, and the answer pinned along the
 * foot where a thumb reaches it. Closing it changes nothing; answering closes
 * it.
 */
function ReviewSheet({
	input,
	browserUrl,
	gitHub,
	briefDestination,
	routineChange,
	routineTimeZone,
	connectorUrl,
	connectorChanged,
	waiting,
	step,
	open,
	onOpenChange,
	bot,
	children,
}: {
	input: ToolCallPart["input"];
	browserUrl: string | undefined;
	gitHub: ApprovalGitHub | undefined;
	briefDestination: BriefDestination;
	routineChange: RoutineChange;
	routineTimeZone: string | undefined;
	connectorUrl: string | null | undefined;
	connectorChanged: boolean | undefined;
	waiting: boolean;
	step: Step;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The bot asking, whose face heads the request. */
	bot: Asker;
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
				style={botColorVariables(bot.color)}
				className="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-none md:inset-auto md:top-1/2 md:left-1/2 md:h-auto md:max-h-approval md:max-w-xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-dialog"
			>
				<div
					ref={top}
					tabIndex={-1}
					className="flex shrink-0 justify-end px-3.5 pt-safe-or-4 outline-none max-md:justify-start max-md:px-4"
				>
					<CloseButton render={<DialogClose />} />
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="flex flex-col gap-4 px-4 py-4">
						<ReviewHeading step={step} bot={bot} headingId={headingId} />
						<ApprovalDestination
							botName={bot.name}
							browserUrl={browserUrl}
							gitHub={gitHub}
							briefDestination={briefDestination}
							routineChange={routineChange}
							routineTimeZone={routineTimeZone}
							connectorUrl={connectorUrl}
							connectorChanged={connectorChanged}
							waiting={waiting}
						/>
						<ExactRequest input={input} />
					</div>
				</ScrollArea>
				<footer className="shrink-0 border-border-subtle border-t px-4 pt-3 pb-safe-or-4">
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
function ReviewHeading({ step, bot, headingId }: { step: Step; bot: Asker; headingId: string }) {
	return (
		<div className="flex flex-col items-center gap-1 pb-2 text-center">
			<span aria-hidden className="relative mb-2.5 inline-flex">
				<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={64} />
				<span className="absolute -right-2 -bottom-1 rounded-lg ring-3 ring-panel">
					<StepMark step={step} size="sm" />
				</span>
			</span>
			<h2
				id={headingId}
				className="m-0 text-balance font-bold text-xl text-foreground leading-tight wrap-anywhere"
			>
				{step.action}
			</h2>
			<p className="m-0 text-pretty text-sm text-muted-foreground">{step.who}</p>
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
	const buttonSize = pinned ? cn(TOUCH_BUTTON, "flex-1") : "h-8 px-4 text-xs";
	const allow = (
		<Button
			disabled={pending}
			onClick={() => onDecide("allow_once")}
			aria-label={`Allow: ${actionLabel}`}
			className={buttonSize}
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
			className={buttonSize}
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
function parseFields(value: unknown): Fields | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const fields = Object.entries(value);
	return fields.length > 0 ? fields : undefined;
}

/** A list with nothing structured in it, shown as one value rather than laid out as entries. */
function isPlainList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.every((item) => item === null || typeof item !== "object");
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
function RequestValue({ value, depth }: { value: unknown; depth: number }) {
	const fields = parseFields(value);
	if (fields && depth < MAX_DEPTH) return <FieldList fields={fields} depth={depth} />;
	if (isRecordList(value) && depth < MAX_DEPTH) return <EntryList entries={value} depth={depth} />;
	if (value !== null && typeof value === "object" && !isPlainList(value)) {
		return (
			<pre className="m-0 whitespace-pre-wrap wrap-anywhere rounded-md bg-list px-2.5 py-2 font-mono text-2xs">
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
		<dl className="m-0 flex flex-col gap-3 md:grid md:grid-cols-capped-label md:gap-x-2.5 md:gap-y-0.5">
			{fields.map(([key, value]) => {
				const nested = hasStructure(value);
				return (
					<div
						key={key}
						className="flex min-w-0 flex-col gap-0.5 md:col-span-2 md:grid md:grid-cols-subgrid md:gap-0"
					>
						<dt className="text-sm text-muted-foreground leading-normal md:min-w-20">
							{wordsFromKey(key)}
						</dt>
						{nested ? (
							<dd className="col-span-2 m-0 min-w-0">
								{Array.isArray(value) && (
									<span className="sr-only">{formatCount(value.length, "entry", "entries")}</span>
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
	return isRecordList(value) || parseFields(value) !== undefined;
}

/** A list of records, the first few until asked for the rest. */
function EntryList({ entries, depth }: { entries: unknown[]; depth: number }) {
	const [showAll, setShowAll] = useState(false);
	return (
		<div className="flex flex-col items-start gap-2">
			<Entries entries={showAll ? entries : entries.slice(0, ENTRIES_SHOWN)} depth={depth} />
			{entries.length > ENTRIES_SHOWN && (
				<Button
					variant="link"
					size="text"
					onClick={() => setShowAll((was) => !was)}
					className="ml-7 font-semibold"
				>
					{showAll ? "Show fewer" : `Show all ${entries.length}`}
				</Button>
			)}
		</div>
	);
}

/**
 * Records as numbered entries. Records that all share the same few fields are
 * a table, so those fields are named once rather than on every entry.
 */
function Entries({ entries, depth }: { entries: unknown[]; depth: number }) {
	const columns = findSharedColumns(entries);
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
function findSharedColumns(entries: unknown[]): string[] | undefined {
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
							className="pr-4 pb-1 text-left font-normal text-sm text-muted-foreground"
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
	const fields = parseFields(value);
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
					{index > 0 && <span className="text-sm text-muted-foreground">, </span>}
					<span className="text-sm text-muted-foreground">{wordsFromKey(key)}</span>{" "}
					<PlainValue value={value} />
				</Fragment>
			))}
		</p>
	);
}

/**
 * A single value as text: words as written, numbers in even figures, and
 * true, false and emptiness in a quieter voice, since they are flags rather
 * than content. A list is shown as JSON, so each entry's boundaries are exact
 * even when an entry contains a comma.
 */
function PlainValue({ value }: { value: unknown }) {
	if (Array.isArray(value) && value.length === 0) return <Quiet>None</Quiet>;
	if (isPlainList(value)) {
		return (
			<code className="whitespace-pre-wrap wrap-anywhere text-sm leading-normal">
				{JSON.stringify(value)}
			</code>
		);
	}
	if (value === null || value === undefined || value === "") return <Quiet>Empty</Quiet>;
	if (typeof value === "boolean") return <Quiet>{value ? "Yes" : "No"}</Quiet>;
	if (typeof value === "number") {
		return <span className="text-sm tabular-nums leading-normal">{value}</span>;
	}
	if (parseFields(value) === undefined && typeof value === "object") return <Quiet>None</Quiet>;
	return (
		<span className="whitespace-pre-wrap text-pretty text-sm leading-normal wrap-anywhere">
			{String(value)}
		</span>
	);
}

function Quiet({ children }: { children: ReactNode }) {
	return <span className="text-sm text-muted-foreground leading-normal">{children}</span>;
}
