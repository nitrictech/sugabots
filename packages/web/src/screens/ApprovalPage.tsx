import type { AnsweredApproval, ApprovalInbox, ApprovalRequest } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useApprovalApp } from "@/lib/approval-app.ts";
import { useApprovalInbox } from "@/lib/chats.ts";
import { agentChatLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { usePods } from "@/lib/pods.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { toolTitle, wordsFromKey } from "@/lib/tool-names.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { Answer, fieldsOf, RequestValue } from "./ToolApprovalCard.tsx";
import { awaitsApproval } from "./tool-activity.ts";

/** A request as the person's inbox holds it: waiting on their decision, or answered. */
type InboxRequest =
	| { kind: "waiting"; request: ApprovalRequest }
	| { kind: "answered"; request: AnsweredApproval };

/**
 * One approval in full, beside the list of them: who wants to do what, every
 * field of the request in a table, and Allow and Deny, or how it was
 * answered, with a way to the chat it was asked in.
 */
export function ApprovalPage({ callId }: { callId: string }) {
	const inbox = useApprovalInbox();
	if (inbox.isPending) return null;
	const found = findRequest(inbox.data, callId);
	if (!found) {
		return (
			<EmptyState title="This request is no longer here">
				It may have been answered a while ago, or its chat removed.
			</EmptyState>
		);
	}
	return <ApprovalDetail key={callId} found={found} />;
}

function findRequest(inbox: ApprovalInbox | undefined, callId: string): InboxRequest | undefined {
	const waiting = inbox?.waiting.find((candidate) => candidate.call.id === callId);
	if (waiting) return { kind: "waiting", request: waiting };
	const answered = inbox?.answered.find((candidate) => candidate.call.id === callId);
	return answered && { kind: "answered", request: answered };
}

function ApprovalDetail({ found }: { found: InboxRequest }) {
	const { request } = found;
	const { call, agent } = request;
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const { look, appName, action } = useApprovalApp(request);
	const review = useReviewToolCall(request.threadId, request.podId);
	const pod = pods?.find((candidate) => candidate.id === request.podId);
	const chatAgent = agents?.find((candidate) => candidate.id === request.chatAgentId);
	const askedIn = [
		chatAgent && chatAgent.id !== agent.id ? `by ${chatAgent.name}` : undefined,
		pod && `in ${pod.name}`,
		`at ${formatListTime(new Date(call.startedAt), new Date())}`,
	]
		.filter(Boolean)
		.join(" ");
	const fields = fieldsOf(call.input) ?? [];

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<article
				aria-label={`Approval request: ${toolTitle(call.tool)}`}
				className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-8 pt-8 pb-8 max-md:px-5"
			>
				<Link
					from="/$workspace"
					to="./approvals"
					className="focus-ring inline-flex items-center gap-1 self-start rounded-sm font-medium text-link text-sm md:hidden"
				>
					<ChevronLeft aria-hidden size={16} />
					Approvals
				</Link>
				<header className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<span aria-hidden className="flex shrink-0">
							<ConnectionMark presetId={look?.presetId} name={appName} size="sm" />
						</span>
						<div className="flex min-w-0 flex-col">
							<span className="truncate text-muted-foreground text-xs">
								{agent.name} wants to use {appName}
							</span>
							<h1 className="m-0 truncate font-bold text-[20px] text-foreground leading-tight tracking-[-0.01em]">
								{action}
							</h1>
						</div>
					</div>
					<p className="m-0 text-subtle-foreground text-xs">Asked {askedIn}</p>
				</header>
				<dl className="m-0 overflow-hidden rounded-xl border border-border">
					{fields.map(([key, value]) => (
						<Row key={key} label={wordsFromKey(key)}>
							<RequestValue value={value} depth={1} />
						</Row>
					))}
				</dl>
				<div className="flex flex-wrap items-center gap-3 pt-1">
					{found.kind === "answered" ? (
						// Announced when the person has just answered it here.
						<AnswerGiven answer={found.request.answer} announced={review.isSuccess} />
					) : awaitsApproval(call) ? (
						<Answer
							pending={review.isPending || review.isSuccess}
							error={review.error}
							onDecide={(decision) => review.mutate({ toolCallId: call.id, decision })}
							actionLabel={action}
						/>
					) : (
						<p className="m-0 text-[13px] text-muted-foreground">
							No longer waiting: {agent.name} stopped before it was answered.
						</p>
					)}
					<span className="flex-1" />
					{pod && chatAgent && (
						<Link
							{...agentChatLink(
								{ pod, agent: chatAgent },
								request.inMainThread ? {} : { thread: request.threadId },
							)}
							className="focus-ring rounded-sm font-medium text-[13px] text-link"
						>
							Open in {chatAgent.name}
						</Link>
					)}
				</div>
			</article>
		</div>
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
			className="m-0 flex items-center gap-1.5 text-[13px] text-muted-foreground"
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

/** One field of the request: its name, then its value. */
function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 border-border border-b px-3.5 py-2.5 last:border-b-0">
			<dt className="text-[13px] text-subtle-foreground">{label}</dt>
			<dd className="m-0 min-w-0 text-[13px] text-foreground">{children}</dd>
		</div>
	);
}
