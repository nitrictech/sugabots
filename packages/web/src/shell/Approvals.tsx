import type { AnsweredApproval, ApprovalRequest } from "@sugabots/contracts";
import { Link, linkOptions } from "@tanstack/react-router";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useApprovalApp } from "@/lib/approval-app.ts";
import { useApprovalInbox } from "@/lib/chats.ts";
import { conversationLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
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
		<Page title="Approvals" place={{ kind: "tab" }}>
			<div className="flex flex-col gap-3 px-6 pt-6 pb-12 max-md:px-4 max-md:pt-2">
				{inbox.isError && (
					<p className="m-0 px-1 text-muted-foreground">Approvals could not be loaded.</p>
				)}
				{inbox.isSuccess && (
					<>
						{waiting.length === 0 ? (
							<NothingWaiting />
						) : (
							<>
								<SectionHeading>Waiting on you</SectionHeading>
								<ul className="m-0 flex list-none flex-col gap-2 p-0 pb-5">
									{waiting.map((request) => (
										<li key={request.call.id}>
											<WaitingCard request={request} />
										</li>
									))}
								</ul>
							</>
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
										// As Open conversation is on a request's page, centred and sized for a thumb on a phone.
										className="focus-ring self-start rounded-sm px-1 font-medium text-[13px] text-link max-md:self-center max-md:py-2 max-md:text-[15px]"
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

/** In place of the waiting requests while there are none: a card saying so, and what would come here. */
function NothingWaiting() {
	return (
		<div className="mb-5 flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 max-md:rounded-[14px]">
			<span
				aria-hidden
				className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-chip text-muted-foreground"
			>
				<ShieldCheck size={20} strokeWidth={1.75} />
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<p className="m-0 font-medium text-[14px] text-foreground max-md:text-[15px]">
					Nothing waiting on you
				</p>
				<p className="m-0 text-[13px] text-muted-foreground max-md:text-[14px]">
					Bots ask here before they do anything you need to allow.
				</p>
			</div>
		</div>
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
	// A phone answers with two wide buttons, and opens the request whole from its name.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const asked = [
		pod && `in ${pod.name}`,
		`at ${formatListTime(new Date(call.startedAt), new Date())}`,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<article
			aria-label={`${agent.name}: ${action}`}
			className="flex flex-col gap-3 rounded-xl border border-border p-4 max-md:rounded-[14px] max-md:bg-card max-md:p-3.5"
		>
			<Link
				{...approvalLink(request)}
				className="focus-ring -m-1 flex items-start gap-3 rounded-lg p-1 max-md:items-center"
			>
				<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 font-semibold text-[14px] text-foreground max-md:font-medium max-md:text-[17px]">
						{action}
					</h3>
					<span className="text-subtle-foreground text-xs max-md:text-[13px]">
						{agent.name} asked {asked}
					</span>
				</div>
				<ChevronRight
					aria-hidden
					size={16}
					strokeWidth={2}
					className="shrink-0 text-disabled-foreground md:hidden"
				/>
			</Link>
			<div className="ml-9 min-w-0 max-md:ml-0">
				<FoldedRequest input={call.input} />
			</div>
			<div className="ml-9 flex flex-wrap items-center gap-3 max-md:ml-0 max-md:flex-col max-md:items-stretch">
				{awaitsApproval(call) ? (
					<Answer
						pending={review.isPending || review.isSuccess}
						error={review.error}
						onDecide={(decision) => review.mutate({ toolCallId: call.id, decision })}
						actionLabel={action}
						pinned={phone}
					/>
				) : (
					<p className="m-0 text-[13px] text-muted-foreground">
						No longer waiting: {agent.name} stopped before it was answered.
					</p>
				)}
				<span className="flex-1 max-md:hidden" />
				{pod && request.conversationId && (
					<Link
						{...conversationLink(
							{ pod, conversationId: request.conversationId },
							request.threadId === request.conversationId ? {} : { thread: request.threadId },
						)}
						// A phone reaches the conversation from the request's own page.
						className="focus-ring rounded-sm text-[12px] text-muted-foreground hover:text-foreground max-md:hidden"
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
			className="focus-ring flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors hover:bg-message-hover max-md:min-h-14 max-md:px-1 max-md:text-[15px] max-md:active:bg-row-selected"
		>
			<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={20} />
			{/* On a phone, what it would have done over which bot, as two lines. */}
			<span className="min-w-0 flex-1 truncate text-muted-foreground max-md:flex max-md:flex-col max-md:gap-0.5">
				<span className="text-foreground max-md:order-2 max-md:truncate max-md:text-[13px] max-md:text-subtle-foreground">
					{agent.name}
				</span>{" "}
				<span className="max-md:truncate max-md:text-foreground">{action}</span>
			</span>
			<span className="shrink-0 text-muted-foreground text-xs">
				{answer.status === "allowed" ? "Allowed" : "Denied"}
			</span>
			<ListTime at={answer.decidedAt} className="w-16 text-right" />
		</Link>
	);
}
