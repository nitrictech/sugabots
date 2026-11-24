import type { AnsweredApproval, ApprovalRequest } from "@sugabots/contracts";
import { Link, linkOptions } from "@tanstack/react-router";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useApprovalToolSource, useAskedIn } from "@/lib/approval-tool-source.ts";
import { useReviewToolCall } from "@/lib/chat-query.ts";
import { useWorkspaceApprovals } from "@/lib/chats.ts";
import { PendingApprovalAnswer, RequestChatLink } from "@/screens/ApprovalPage.tsx";
import { FoldedRequest } from "@/screens/ToolApprovalCard.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ListTime, Page } from "@/shell/Page.tsx";

/** How many answered requests show before Show older. */
const ANSWERED_SHOWN = 10;

/**
 * Approvals: every request waiting on the member across the workspace, each
 * answered where it stands, then the latest answered, each of which opens in
 * full.
 */
export function Approvals() {
	const approvals = useWorkspaceApprovals();
	const waiting = approvals.data?.waiting ?? [];
	const answered = approvals.data?.answered ?? [];
	const [showAll, setShowAll] = useState(false);
	const answeredShown = showAll ? answered : answered.slice(0, ANSWERED_SHOWN);

	return (
		<Page title="Approvals" place={{ kind: "tab" }}>
			<div className="flex flex-col gap-3 px-6 pt-6 pb-12 max-md:px-4 max-md:pt-1.5">
				{approvals.isError && (
					<p className="m-0 px-1 text-muted-foreground">Approvals could not be loaded.</p>
				)}
				{approvals.isSuccess && (
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
										// As Open chat is on a request's page, centred and sized for a thumb on a phone.
										className="focus-ring self-start rounded-sm px-1 font-medium text-xs text-link max-md:self-center max-md:py-2 max-md:text-sm"
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
		// On a phone, as tall as the card at the top of the next tab's Settings, so moving between them is still.
		<div className="mb-5 flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 max-md:mb-3 max-md:min-h-24.5 max-md:rounded-2xl max-md:py-0">
			<span
				aria-hidden
				className="grid size-10 shrink-0 place-items-center rounded-lg bg-chip text-muted-foreground"
			>
				<ShieldCheck size={20} strokeWidth={1.75} />
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<p className="m-0 font-medium text-sm text-foreground">Nothing waiting on you</p>
				<p className="m-0 text-xs text-muted-foreground max-md:text-sm">
					Bots ask here before they do anything you need to allow.
				</p>
			</div>
		</div>
	);
}

/**
 * A section's quiet heading. On a phone it is set as Settings' group headings
 * are, the next tab's, at the same size and inset and as far from what it
 * heads (with the list's 12px gap, 10px), so moving between them is still.
 */
function SectionHeading({ children }: { children: string }) {
	return (
		<h2 className="m-0 px-1 font-medium text-subtle-foreground text-xs max-md:-mb-0.5 max-md:px-0.5 max-md:text-muted-foreground max-md:leading-normal">
			{children}
		</h2>
	);
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
 * A request waiting on the member, as a card: what the bot would do, which
 * bot, in which project and when, the request itself, and Allow and Deny, with a
 * way to the chat it was asked in.
 */
function WaitingCard({ request }: { request: ApprovalRequest }) {
	const { bot, call } = request;
	const { action } = useApprovalToolSource(request);
	const { project, askedIn: asked } = useAskedIn(request);
	const review = useReviewToolCall(request.chatId);
	return (
		<article
			aria-label={`${bot.name}: ${action}`}
			className="flex flex-col gap-3 rounded-xl border border-border p-4 max-md:rounded-2xl max-md:bg-card max-md:p-3.5"
		>
			<Link
				{...approvalLink(request)}
				className="focus-ring -m-1 flex items-start gap-3 rounded-lg p-1 max-md:items-center"
			>
				<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={24} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h3 className="m-0 font-semibold text-sm text-foreground max-md:font-medium max-md:text-base">
						{action}
					</h3>
					<span className="text-subtle-foreground text-xs">
						{bot.name} asked {asked}
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
				<PendingApprovalAnswer request={request} actionLabel={action} review={review} />
				<span className="flex-1 max-md:hidden" />
				<RequestChatLink
					request={request}
					project={project}
					// A phone reaches the chat from the request's own page.
					className="focus-ring rounded-sm text-xs text-muted-foreground hover:text-foreground max-md:hidden"
				/>
			</div>
		</article>
	);
}

/** A request already answered: which bot, what it would have done, which way it went, and when. */
function ResolvedRow({ request }: { request: AnsweredApproval }) {
	const { action } = useApprovalToolSource(request);
	const { bot, answer } = request;
	return (
		<Link
			{...approvalLink(request)}
			className="focus-ring flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs transition-colors hover:bg-message-hover max-md:min-h-14 max-md:px-1 max-md:text-sm max-md:active:bg-row-selected"
		>
			<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={20} />
			{/* On a phone, what it would have done over which bot, as two lines. */}
			<span className="min-w-0 flex-1 truncate text-muted-foreground max-md:flex max-md:flex-col max-md:gap-0.5">
				<span className="text-foreground max-md:order-2 max-md:truncate max-md:text-xs max-md:text-subtle-foreground">
					{bot.name}
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
