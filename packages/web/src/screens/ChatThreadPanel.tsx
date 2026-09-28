import type {
	ChatHistoryEntry,
	RoutineExecution,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Braces, ChevronLeft, CircleAlert, Repeat } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAgentWithPod } from "@/lib/agents.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadEvents, useThreadNotices } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import type { ChatThreadType } from "./ChatActivityRow.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { ThreadConversation } from "./ThreadConversation.tsx";
import { ThreadNotices } from "./ThreadNotices.tsx";
import { PinnedApproval } from "./ToolApprovalCard.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/**
 * A collaboration or routine run opened from its line, as the sidebar beside
 * the chat. A collaboration shows its two bots and their thread mirrored: the
 * chat's bot on the right, the one it asked on the left.
 */
export function ChatThreadPanel({
	chatId,
	chatAgentId,
	threadId,
	entry,
	history,
	user,
	onClose,
	onOpenThread,
}: {
	chatId: string;
	/** The bot whose chat this opened from, which a collaboration draws on the right. */
	chatAgentId: string;
	threadId: string;
	entry?: ChatHistoryEntry;
	history: ChatHistoryEntry[];
	user: SessionUser;
	onClose: () => void;
	onOpenThread: (threadId: string) => void;
}) {
	const query = useThread(threadId);
	useThreadEvents(threadId);
	const notices = useThreadNotices(threadId);
	const heading = useRef<HTMLHeadingElement>(null);
	const timeline = useRef<HTMLDivElement>(null);
	const details = query.data;
	const type = openableThreadType(entry?.type ?? details?.thread.type);
	const routineExecution = details?.routineExecution;
	const parentRoutine = history.find(
		(item) => item.threadId === details?.thread.parentThreadId && item.type === "routine",
	);
	const host = details?.participants.find(
		(participant): participant is AgentParticipant =>
			participant.kind === "agent" && participant.id === details.thread.hostAgentId,
	);
	// A collaboration is seen from the chat's bot: it first, on the right, and the other bot beside it.
	const mine =
		details?.participants.find(
			(participant): participant is AgentParticipant =>
				participant.kind === "agent" && participant.id === chatAgentId,
		) ?? host;
	const other = details?.participants.find(
		(participant): participant is AgentParticipant =>
			participant.kind === "agent" && participant.id !== mine?.id,
	);

	useEffect(() => {
		if (threadId) heading.current?.focus();
	}, [threadId]);

	async function loadOlder() {
		const element = timeline.current;
		const height = element?.scrollHeight ?? 0;
		const top = element?.scrollTop ?? 0;
		await query.loadOlder();
		requestAnimationFrame(() => {
			if (element) element.scrollTop = top + element.scrollHeight - height;
		});
	}

	const title = details?.thread.title ?? "Thread";
	// The first call still waiting on a person, whose answer a phone pins to the sheet's foot.
	const waiting = details?.messages
		.flatMap((message) => message.parts)
		.find(
			(part): part is ToolCallPart =>
				part.type === "tool_call" &&
				part.status === "awaiting_approval" &&
				part.approval?.status === "pending",
		);
	return (
		<ChatSidebar
			label={title}
			onClose={onClose}
			sheet
			// Wider than Details: it holds a whole conversation, bubbles and all.
			className="w-[520px] bg-background md:max-xl:w-[min(560px,100%)]"
		>
			{query.isPending ? (
				<div className="grid flex-1 place-content-center text-muted-foreground text-sm">
					Loading thread…
				</div>
			) : !details ||
				!host ||
				!type ||
				(details.thread.chatId !== chatId && entry?.threadId !== threadId) ? (
				<EmptyState title="Could not load this thread">
					Try closing this panel and opening it again.
				</EmptyState>
			) : (
				<>
					{/* On a phone the sheet has less room, so the heading sits beside smaller faces. */}
					<header className="flex shrink-0 flex-col items-center gap-1.5 px-[18px] pb-[18px] text-center max-md:flex-row max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:pb-3 max-md:text-left">
						{parentRoutine && (
							<button
								type="button"
								onClick={() => onOpenThread(parentRoutine.threadId)}
								className="focus-ring mb-1 inline-flex items-center gap-1 self-start rounded-md font-medium text-link text-sm max-md:mb-0 max-md:w-full"
							>
								<ChevronLeft aria-hidden size={14} />
								Back to Routine
							</button>
						)}
						{type === "collaboration" ? (
							<span aria-hidden className="relative h-[60px] w-24 shrink-0 max-md:h-8 max-md:w-12">
								<AgentAvatar
									color={(mine ?? host).color}
									face={(mine ?? host).face}
									size={60}
									className="absolute top-0 left-0 max-md:size-8"
								/>
								{other && (
									<AgentAvatar
										color={other.color}
										face={other.face}
										size={60}
										className="absolute top-0 left-9 rounded-full shadow-[0_0_0_4px_var(--background)] max-md:left-4 max-md:size-8 max-md:shadow-[0_0_0_3px_var(--list)]"
									/>
								)}
							</span>
						) : (
							<span
								aria-hidden
								className="grid size-[60px] shrink-0 place-items-center rounded-full bg-chip text-soft-foreground max-md:size-8"
							>
								<Repeat size={26} strokeWidth={2} className="max-md:size-4" />
							</span>
						)}
						<div className="flex min-w-0 flex-col items-center gap-1.5 max-md:flex-1 max-md:items-start max-md:gap-0">
							<h2
								ref={heading}
								tabIndex={-1}
								className="m-0 pt-1.5 font-bold text-[19px] text-foreground outline-none max-md:truncate max-md:pt-0 max-md:text-[17px]"
							>
								{type === "collaboration"
									? "Collaboration"
									: (routineExecution?.routineName ?? title)}
							</h2>
							<p className="m-0 text-[13.5px] text-muted-foreground max-md:truncate">
								{type === "collaboration" ? (other ? `with ${other.name}` : title) : "Routine run"}
							</p>
						</div>
						{type === "routine" && routineExecution && (
							<RoutineHeaderActions execution={routineExecution} />
						)}
					</header>
					<div
						ref={timeline}
						role="log"
						aria-label="Thread messages"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a thread longer than the sheet scrolls, so the keyboard has to reach it too.
						tabIndex={0}
						className="focus-ring min-h-0 flex-1 overflow-y-auto px-3.5 pt-1 pb-4"
					>
						{query.loadOlderError && (
							<p role="alert" className="m-0 pb-3 text-destructive-text text-sm">
								Earlier messages could not be loaded.
							</p>
						)}
						{details.olderMessagesCursor && (
							<Button
								variant="link"
								size="bare"
								className="mx-auto mb-3 flex"
								disabled={query.isLoadingOlder}
								onClick={() => void loadOlder().catch(() => {})}
							>
								{query.isLoadingOlder ? "Loading…" : "Load older messages"}
							</Button>
						)}
						{type === "routine" && routineExecution?.error && (
							<p
								role="alert"
								className="mb-4 flex items-start gap-2 rounded-lg bg-destructive-hover px-3 py-2.5 text-destructive-text text-sm"
							>
								<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
								{routineExecution.error}
							</p>
						)}
						<ThreadConversation
							messages={
								type === "routine"
									? details.messages.filter((message) => message.author.kind !== "routine_trigger")
									: details.messages
							}
							host={host}
							// A notice says the reply is not coming, so nobody is shown typing it.
							isRunning={details.thread.status === "running" && notices.length === 0}
							participants={[...details.participants, ...details.crew]}
							user={user}
							rightAgentId={type === "collaboration" ? mine?.id : undefined}
							onOpenCollaboration={onOpenThread}
							podId={details.thread.podId}
							canApproveToolCalls={details.capabilities?.approveToolCalls}
							compact
							approvalsPinned
						/>
						<ThreadNotices notices={notices} />
					</div>
					{waiting && (
						<div className="shrink-0 md:hidden">
							<PinnedApproval
								call={waiting}
								threadId={details.thread.id}
								podId={details.thread.podId}
								canApprove={details.capabilities?.approveToolCalls ?? false}
							/>
						</div>
					)}
				</>
			)}
		</ChatSidebar>
	);
}

function RoutineHeaderActions({ execution }: { execution: RoutineExecution }) {
	const backToChat = useBackToHere("Chat");
	const placed = useAgentWithPod(execution.agentId);
	return (
		<div className="flex items-center gap-1 pt-1">
			{execution.trigger.kind === "webhook" && (
				<details className="group relative">
					<summary
						aria-label="View webhook payload"
						className="focus-ring grid size-[30px] cursor-pointer list-none place-items-center rounded-lg text-muted-foreground hover:bg-list hover:text-foreground [&::-webkit-details-marker]:hidden"
					>
						<Braces aria-hidden size={15} />
					</summary>
					{/* Left-aligned: it hangs from a centred header, and code reads from the left. */}
					<div className="absolute left-1/2 z-20 mt-2 w-[min(328px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-panel bg-panel text-left shadow-dialog">
						{execution.trigger.idempotencyKey && (
							<div className="flex items-baseline gap-2 border-border border-b px-4 py-2.5 text-[13px]">
								<span className="text-muted-foreground">Idempotency key</span>
								<code className="truncate font-mono text-foreground">
									{execution.trigger.idempotencyKey}
								</code>
							</div>
						)}
						<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] text-soft-foreground leading-relaxed">
							{JSON.stringify(execution.trigger.payload, null, 2)}
						</pre>
					</div>
				</details>
			)}
			{placed && (
				<Link
					{...agentSettingsLink(placed)}
					state={backToChat}
					search={{ tab: "routines" }}
					aria-label="View routine definition"
					className="focus-ring grid size-[30px] place-items-center rounded-lg text-muted-foreground hover:bg-list hover:text-link"
				>
					<ArrowUpRight aria-hidden size={15} />
				</Link>
			)}
		</div>
	);
}

function openableThreadType(type: string | undefined): ChatThreadType | undefined {
	return type === "collaboration" || type === "routine" ? type : undefined;
}
