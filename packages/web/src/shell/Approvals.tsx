import type { AnsweredApproval, ApprovalRequest } from "@sugabots/contracts";
import { Link, linkOptions } from "@tanstack/react-router";
import { useState } from "react";
import { useApprovalApp } from "@/lib/approval-app.ts";
import { useApprovalInbox } from "@/lib/chats.ts";
import { conversationLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { usePods } from "@/lib/pods.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { Answer, FoldedRequest } from "@/screens/ToolApprovalCard.tsx";
import { awaitsApproval } from "@/screens/tool-activity.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListTime, Page } from "@/shell/Page.tsx";

/** How many answered requests show before Show older. */
const ANSWERED_SHOWN = 10;

/**
 * Approvals: every request waiting on the person across the workspace, each
 * answered where it stands, then the latest answered, each of which opens in
 * full.
 */
export function Approvals() {
	const inbox = useApprovalInbox();
	const waiting = inbox.data?.waiting ?? [];
	const answered = inbox.data?.answered ?? [];
	const [showAll, setShowAll] = useState(false);
	const answeredShown = showAll ? answered : answered.slice(0, ANSWERED_SHOWN);

	return (
		<Page title="Approvals">
			<div className="flex flex-col gap-3 px-6 pt-6 pb-12 max-md:px-3">
				{inbox.isError && (
					<p className="m-0 px-1 text-muted-foreground">Approvals could not be loaded.</p>
				)}
				{inbox.isSuccess && (
					<>
						<SectionHeading>Waiting on you</SectionHeading>
						{waiting.length === 0 ? (
							<p className="m-0 px-1 pb-4 text-[13px] text-subtle-foreground">
								Nothing waiting. Bots ask here before they do anything you need to allow.
							</p>
						) : (
							<ul className="m-0 flex list-none flex-col gap-2 p-0 pb-5">
								{waiting.map((request) => (
									<li key={request.call.id}>
										<WaitingCard request={request} />
									</li>
								))}
							</ul>
						)}
						{answered.length > 0 && (
							<>
								<SectionHeading>Resolved</SectionHeading>
								<ul className="m-0 flex list-none flex-col p-0">
									{answeredShown.map((request) => (
										<li key={request.call.id}>
											<ResolvedRow request={request} />
										</li>
									))}
								</ul>
								{answered.length > answeredShown.length && (
									<button
										type="button"
										onClick={() => setShowAll(true)}
										className="focus-ring self-start rounded-sm px-1 font-medium text-[13px] text-link"
									>
										Show older
									</button>
								)}
							</>
						)}
					</>
				)}
			</div>
		</Page>
	);
}

function SectionHeading({ children }: { children: string }) {
	return <h2 className="m-0 px-1 font-medium text-subtle-foreground text-xs">{children}</h2>;
}

/** A request's own page, with every field of it. */
function approvalLink(request: ApprovalRequest) {
	return linkOptions({
		from: "/$workspace",
		to: "./approvals/$call",
		params: { call: request.call.id },
	});
}

/**
 * A request waiting on the person, as a card: what the bot would do, which
 * bot, in which pod and when, the request itself, and Allow and Deny, with a
 * way to the conversation it was asked in.
 */
function WaitingCard({ request }: { request: ApprovalRequest }) {
	const { agent, call } = request;
	const { action } = useApprovalApp(request);
	const { data: pods } = usePods();
	const pod = pods?.find((candidate) => candidate.id === request.podId);
	const review = useReviewToolCall(request.threadId, request.podId);
	const asked = [
		pod && `in ${pod.name}`,
		`at ${formatListTime(new Date(call.startedAt), new Date())}`,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<article
			aria-label={`${agent.name}: ${action}`}
			className="flex flex-col gap-3 rounded-xl border border-border p-4"
		>
			<div className="flex items-start gap-3">
				<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 font-semibold text-[14px] text-foreground">{action}</h3>
					<span className="text-subtle-foreground text-xs">
						{agent.name} asked {asked}
					</span>
				</div>
			</div>
			<div className="ml-9 min-w-0">
				<FoldedRequest input={call.input} />
			</div>
			<div className="ml-9 flex flex-wrap items-center gap-3">
				{awaitsApproval(call) ? (
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
				{pod && request.conversationId && (
					<Link
						{...conversationLink(
							{ pod, conversationId: request.conversationId },
							request.threadId === request.conversationId ? {} : { thread: request.threadId },
						)}
						className="focus-ring rounded-sm text-[12px] text-muted-foreground hover:text-foreground"
					>
						Open conversation
					</Link>
				)}
			</div>
		</article>
	);
}

/** A request already answered: which bot, what it would have done, which way it went, and when. */
function ResolvedRow({ request }: { request: AnsweredApproval }) {
	const { action } = useApprovalApp(request);
	const { agent, answer } = request;
	return (
		<Link
			{...approvalLink(request)}
			className="focus-ring flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors hover:bg-message-hover"
		>
			<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={20} />
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				<span className="text-foreground">{agent.name}</span> {action}
			</span>
			<span className="shrink-0 text-muted-foreground text-xs">
				{answer.status === "allowed" ? "Allowed" : "Denied"}
			</span>
			<ListTime at={answer.decidedAt} className="w-16 text-right" />
		</Link>
	);
}
