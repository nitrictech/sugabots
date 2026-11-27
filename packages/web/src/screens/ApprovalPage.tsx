import type {
	AnsweredApproval,
	ApprovalRequest,
	Project,
	WorkspaceApprovals,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { useApprovalToolSource, useAskedIn } from "@/lib/approval-tool-source.ts";
import { useReviewToolCall } from "@/lib/chat-query.ts";
import { useWorkspaceApprovals } from "@/lib/chats.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { toolTitle } from "@/lib/tool-names.ts";
import { ChatLink } from "@/shell/ChatLink.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { PageBackLink } from "@/ui/settings-page.tsx";
import { Answer, ApprovalDestination, ExactRequest } from "./ToolApprovalCard.tsx";
import { awaitsApproval } from "./tool-activity.ts";

/** A request as the member's approvals list it: waiting on their decision, or answered. */
type ListedRequest =
	| { kind: "waiting"; request: ApprovalRequest }
	| { kind: "answered"; request: AnsweredApproval };

/**
 * One approval in full, on its own page: who wants to do what, every
 * input of the request as JSON, and Allow and Deny, or how it was
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
	const { connector, toolSourceName, action, hostRequest } = useApprovalToolSource(
		request,
		found.kind === "waiting" && awaitsApproval(call),
	);
	const review = useReviewToolCall(request.chatId);
	const { project, askedIn } = useAskedIn(request);

	return (
		<div className="tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<article
				aria-label={`Approval request: ${toolTitle(call.tool)}`}
				className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-8 pt-8 pb-8 max-md:gap-5 max-md:px-4 max-md:pt-safe-or-3"
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
							<ConnectorMark
								markId={connector?.markId}
								name={toolSourceName}
								icon={hostRequest?.icon}
								size="sm"
							/>
						</span>
						{/* On a phone, the title first, then one line of who asked, for what, where and when. */}
						<div className="flex min-w-0 flex-col max-md:flex-col-reverse max-md:gap-1">
							<span className="truncate text-muted-foreground text-xs max-md:whitespace-normal max-md:text-sm">
								{hostRequest?.description ?? `${bot.name} wants to use ${toolSourceName}`}
								<span className="ms-3 md:hidden">{askedIn}</span>
							</span>
							<h1 className="m-0 truncate font-bold text-xl text-foreground leading-tight tracking-normal max-md:whitespace-normal max-md:font-semibold">
								{action}
							</h1>
						</div>
					</div>
					<p className="m-0 text-subtle-foreground text-xs max-md:hidden">Asked {askedIn}</p>
				</header>
				<ApprovalDestination
					browserUrl={call.approval?.browserUrl}
					connectorUrl={connector?.url}
					connectorChanged={connector?.changed}
				/>
				<ExactRequest input={call.input} />
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
			onDecide={(decision) => review.mutate({ call, decision })}
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

/**
 * Open chat: the chat a request was asked in, or, for one an automation's run
 * asked, its automation's feed at that run. A project's chat links once
 * `project` is known; a request outside any chat has none.
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
	if (!request.chatId || !request.rootChatId || (request.projectId !== null && !project))
		return null;
	return (
		<ChatLink
			project={project ?? null}
			chatId={request.rootChatId}
			search={request.chatId === request.rootChatId ? {} : { runChat: request.chatId }}
			className={className}
		>
			Open chat
		</ChatLink>
	);
}
