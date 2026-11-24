import type {
	AnsweredApproval,
	ApprovalRequest,
	Project,
	WorkspaceApprovals,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { useApprovalToolSource, useAskedIn } from "@/lib/approval-tool-source.ts";
import { useReviewToolCall } from "@/lib/chat-query.ts";
import { useWorkspaceApprovals } from "@/lib/chats.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { toolTitle, wordsFromKey } from "@/lib/tool-names.ts";
import { ChatLink } from "@/shell/ChatLink.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { PageBackLink } from "@/ui/settings-page.tsx";
import { Answer, fieldsOf, RequestValue } from "./ToolApprovalCard.tsx";
import { awaitsApproval } from "./tool-activity.ts";

/** A request as the member's approvals list it: waiting on their decision, or answered. */
type ListedRequest =
	| { kind: "waiting"; request: ApprovalRequest }
	| { kind: "answered"; request: AnsweredApproval };

/**
 * One approval in full, on its own page: who wants to do what, every
 * field of the request in a table, and Allow and Deny, or how it was
 * answered, with a way to the chat it was asked in.
 */
export function ApprovalPage({ callId }: { callId: string }) {
	const approvals = useWorkspaceApprovals();
	if (approvals.isPending) return null;
	const found = findRequest(approvals.data, callId);
	if (!found) {
		return (
			<EmptyState title="This request is no longer here">
				It may have been answered a while ago, or its chat removed.
			</EmptyState>
		);
	}
	return <ApprovalDetail key={callId} found={found} />;
}

function findRequest(
	approvals: WorkspaceApprovals | undefined,
	callId: string,
): ListedRequest | undefined {
	const waiting = approvals?.waiting.find((candidate) => candidate.call.id === callId);
	if (waiting) return { kind: "waiting", request: waiting };
	const answered = approvals?.answered.find((candidate) => candidate.call.id === callId);
	return answered && { kind: "answered", request: answered };
}

function ApprovalDetail({ found }: { found: ListedRequest }) {
	const { request } = found;
	const { call, bot } = request;
	const { connector, toolSourceName, action } = useApprovalToolSource(request);
	const review = useReviewToolCall(request.chatId);
	const { project, askedIn } = useAskedIn(request);
	const fields = fieldsOf(call.input) ?? [];

	return (
		<div className="tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<article
				aria-label={`Approval request: ${toolTitle(call.tool)}`}
				className="mx-auto flex w-full max-w-220 flex-col gap-4 px-8 pt-8 pb-8 max-md:gap-5 max-md:px-4 max-md:pt-safe-or-3"
			>
				<PageBackLink
					label="Approvals"
					render={
						<Link
							from="/$workspace"
							to="./approvals"
							aria-label="Back to Approvals"
							className="self-start"
						/>
					}
				/>
				<header className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<span aria-hidden className="flex shrink-0">
							<ConnectorMark markId={connector?.markId} name={toolSourceName} size="sm" />
						</span>
						{/* On a phone, the title first, then one line of who asked, for what, where and when. */}
						<div className="flex min-w-0 flex-col max-md:flex-col-reverse max-md:gap-1">
							<span className="truncate text-muted-foreground text-xs max-md:whitespace-normal max-md:text-sm">
								{bot.name} wants to use {toolSourceName}
								<span className="md:hidden"> · {askedIn}</span>
							</span>
							<h1 className="m-0 truncate font-bold text-xl text-foreground leading-tight tracking-normal max-md:whitespace-normal max-md:font-semibold">
								{action}
							</h1>
						</div>
					</div>
					<p className="m-0 text-subtle-foreground text-xs max-md:hidden">Asked {askedIn}</p>
				</header>
				<dl className="m-0 overflow-hidden rounded-xl border border-border">
					{fields.map(([key, value]) => (
						<Row key={key} label={wordsFromKey(key)}>
							<RequestValue value={value} depth={1} />
						</Row>
					))}
				</dl>
				<div className="flex flex-wrap items-center gap-3 pt-1 max-md:flex-col max-md:items-stretch max-md:gap-4">
					{found.kind === "answered" ? (
						// Announced when the member has just answered it here.
						<AnswerGiven answer={found.request.answer} announced={review.isSuccess} />
					) : (
						<PendingApprovalAnswer request={request} actionLabel={action} review={review} />
					)}
					<span className="flex-1 max-md:hidden" />
					<RequestChatLink
						request={request}
						project={project}
						className="focus-ring rounded-sm font-medium text-xs text-link max-md:self-center max-md:py-2 max-md:text-sm"
					/>
				</div>
			</article>
		</div>
	);
}

/**
 * Allow and Deny for a request still waiting on the member, or, once its bot
 * stopped before it was answered, that it no longer waits. A phone answers with
 * two wide buttons. `review` answers it, so the caller can tell once it has.
 */
export function PendingApprovalAnswer({
	request,
	actionLabel,
	review,
}: {
	request: ApprovalRequest;
	/** What would be allowed, for Allow's accessible name. */
	actionLabel: string;
	review: ReturnType<typeof useReviewToolCall>;
}) {
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const { call, bot } = request;
	if (!awaitsApproval(call)) {
		return (
			<p className="m-0 text-xs text-muted-foreground">
				No longer waiting: {bot.name} stopped before it was answered.
			</p>
		);
	}
	return (
		<Answer
			pending={review.isPending || review.isSuccess}
			error={review.error}
			onDecide={(decision) => review.mutate({ toolCallId: call.id, decision })}
			actionLabel={actionLabel}
			pinned={phone}
		/>
	);
}

/** How a request was answered, by whom, and when; `announced` makes it a live region. */
function AnswerGiven({
	answer,
	announced,
}: {
	answer: AnsweredApproval["answer"];
	announced: boolean;
}) {
	const allowed = answer.status === "allowed";
	return (
		<p
			role={announced ? "status" : undefined}
			className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground"
		>
			{allowed ? (
				<Check aria-hidden size={13} strokeWidth={2.8} />
			) : (
				<X aria-hidden size={13} strokeWidth={2.8} />
			)}
			{allowed ? "Allowed" : "Denied"}
			{answer.decidedByName && ` by ${answer.decidedByName}`}
			{` at ${formatListTime(new Date(answer.decidedAt), new Date())}`}
		</p>
	);
}

/** One field of the request: its name, then its value; on a phone, the name over the value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-label gap-4 border-border border-b px-3.5 py-2.5 last:border-b-0 max-md:grid-cols-1 max-md:gap-1 max-md:py-3">
			<dt className="text-xs text-subtle-foreground max-md:text-sm">{label}</dt>
			<dd className="m-0 min-w-0 text-xs text-foreground max-md:text-sm">{children}</dd>
		</div>
	);
}

/**
 * Open chat: the chat a request was asked in, or, for one an automation's run
 * asked, that run as the page of its automation's feed. A project's chat
 * links once `project` is known; a request outside any chat has none.
 */
export function RequestChatLink({
	request,
	project,
	className,
}: {
	request: ApprovalRequest;
	/** The project it was asked in, as `useAskedIn` finds it. */
	project: Project | undefined;
	className: string;
}) {
	if (!request.rootChatId || (request.projectId !== null && !project)) return null;
	return (
		<ChatLink
			project={project ?? null}
			chatId={request.rootChatId}
			search={request.chatId === request.rootChatId ? {} : { nestedChatPage: request.chatId }}
			className={className}
		>
			Open chat
		</ChatLink>
	);
}
