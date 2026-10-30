import type { ChatHistoryEntry, RoutineExecution, ThreadParticipant } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Braces, ChevronLeft, ExternalLink } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { routineThreadLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadEvents, useThreadNotices } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import type { ChatThreadType } from "./ChatActivityRow.tsx";
import { type BackTo, HeaderBack } from "./ChatHeader.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { mentionableIn } from "./mentions.tsx";
import { FailedRunMessage } from "./RoutineRun.tsx";
import { ThreadConversation } from "./ThreadConversation.tsx";
import { ThreadNotices } from "./ThreadNotices.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/**
 * Where a thread panel is shown: as the sidebar beside the chat, which closes,
 * or as a page of its own where the chat would be, as Activity opens one, with
 * a phone's Back to the list it covers and something at its header's right,
 * such as the way to the chat itself.
 */
export type ThreadFrame =
	| { kind: "sidebar"; onClose: () => void }
	| { kind: "page"; back: BackTo; trailing: ReactNode };

/** A collaboration or routine run opened from its line, framed by `frame`. */
export function ChatThreadPanel({
	conversationId,
	chatAgentId,
	threadId,
	entry,
	history,
	frame,
	onOpenThread,
	onOpenArtifact,
}: {
	conversationId: string;
	/** The bot whose chat this opened from, which a collaboration draws on the right. */
	chatAgentId: string;
	threadId: string;
	entry?: ChatHistoryEntry;
	history: ChatHistoryEntry[];
	frame: ThreadFrame;
	onOpenThread: (threadId: string) => void;
	onOpenArtifact?: (artifactId: string) => void;
}) {
	const query = useThread(threadId);
	const authorLinkOf = useAuthorLinks(query.data?.thread.podId);
	useThreadEvents(threadId);
	const notices = useThreadNotices(threadId);
	const heading = useRef<HTMLHeadingElement>(null);
	const timeline = useRef<HTMLDivElement>(null);
	const details = query.data;
	const type = openableThreadType(entry?.type ?? details?.thread.type, frame);
	const routineExecution = details?.routineExecution;
	// Beside a chat a run never opens, so neither is there a way back to one.
	const parentRoutine =
		frame.kind === "sidebar"
			? undefined
			: history.find(
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
	const headed = {
		label: title,
		heading:
			type === "collaboration"
				? "Collaboration"
				: type === "routine"
					? (routineExecution?.routineName ?? title)
					: title,
		subheading: type === "collaboration" ? other && `${mine?.name} and ${other.name}` : undefined,
		headingRef: heading,
		actions: type === "routine" && routineExecution && (
			<RoutineHeaderActions execution={routineExecution} podId={details.thread.podId} />
		),
	};
	const body = query.isPending ? (
		<div className="grid flex-1 place-content-center text-muted-foreground text-sm">
			Loading thread…
		</div>
	) : !details ||
		!host ||
		!type ||
		(details.thread.conversationId !== conversationId && entry?.threadId !== threadId) ? (
		<EmptyState title="Could not load this thread">
			{frame.kind === "sidebar"
				? "Try closing this panel and opening it again."
				: "Go back and open it again."}
		</EmptyState>
	) : (
		<>
			{parentRoutine && (
				<button
					type="button"
					onClick={() => onOpenThread(parentRoutine.threadId)}
					className="focus-ring mx-[18px] mt-3 inline-flex items-center gap-1 self-start rounded-md font-medium text-link text-sm"
				>
					<ChevronLeft aria-hidden size={14} />
					Back to Routine
				</button>
			)}
			<div
				ref={timeline}
				role="log"
				aria-label="Thread messages"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a thread longer than the sheet scrolls, so the keyboard has to reach it too.
				tabIndex={0}
				className="focus-ring min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-2 pb-2"
			>
				{query.loadOlderError && (
					<p role="alert" className="m-0 px-[18px] pb-3 text-destructive-text text-sm">
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
				{type === "routine" && routineExecution?.state === "failed" && (
					<FailedRunMessage execution={routineExecution} agent={host} />
				)}
				<ThreadConversation
					fileUrlOf={(fileId) => chatFileUrl(conversationId, fileId)}
					messages={
						type === "routine"
							? details.messages.filter((message) => message.author.kind !== "routine_trigger")
							: details.messages
					}
					host={host}
					// A notice says the reply is not coming, so nobody is shown typing it.
					isRunning={details.thread.status === "running" && notices.length === 0}
					participants={mentionableIn(details)}
					onOpenThread={onOpenThread}
					onOpenArtifact={onOpenArtifact}
					podId={details.thread.podId}
					approvalCapabilities={details.capabilities}
					compact
					authorLinkOf={authorLinkOf}
				/>
				<ThreadNotices notices={notices} />
			</div>
			{frame.kind === "sidebar" && type === "collaboration" && mine && (
				<p className="m-0 shrink-0 border-border border-t px-[18px] py-3 text-[12.5px] text-subtle-foreground leading-normal">
					Bots talk here on their own. To weigh in, message {mine.name} in the main chat.
				</p>
			)}
		</>
	);
	if (frame.kind === "page") {
		return (
			<ThreadPage {...headed} back={frame.back} trailing={frame.trailing}>
				{body}
			</ThreadPage>
		);
	}
	return (
		<ChatSidebar
			{...headed}
			onClose={frame.onClose}
			sheet
			// Wider than Details: it holds a whole conversation.
			className="w-[560px] md:max-xl:w-[min(600px,100%)]"
		>
			{body}
		</ChatSidebar>
	);
}

/** A thread as a page of its own: a header naming it, and the thread under it. */
function ThreadPage({
	label,
	heading,
	subheading,
	headingRef,
	actions,
	back,
	trailing,
	children,
}: {
	label: string;
	heading: string;
	subheading?: string;
	headingRef: Ref<HTMLHeadingElement>;
	actions?: ReactNode;
	back: BackTo;
	trailing: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="relative flex h-[52px] shrink-0 items-center gap-2 border-border border-b pr-4 pl-6 max-md:pl-12">
				<HeaderBack back={back} />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1
						ref={headingRef}
						tabIndex={-1}
						className="m-0 min-w-0 shrink-0 truncate font-medium text-[14px] text-foreground outline-none max-md:shrink"
					>
						{heading}
					</h1>
					{subheading && (
						<span className="min-w-0 truncate text-[13px] text-subtle-foreground">
							{subheading}
						</span>
					)}
				</div>
				{actions}
				{trailing}
			</header>
			{children}
		</section>
	);
}

function RoutineHeaderActions({
	execution,
	podId,
}: {
	execution: RoutineExecution;
	/** The pod the run happened in, whose Routines page the routine is changed on. */
	podId: string;
}) {
	const backToChat = useBackToHere("Chat");
	const pod = usePods().data?.find((one) => one.id === podId);
	return (
		<>
			{execution.trigger.kind === "webhook" && (
				<details className="group relative">
					<IconButton
						label="View webhook payload"
						variant="bar"
						render={<summary />}
						className="list-none [&::-webkit-details-marker]:hidden"
					>
						<Braces aria-hidden size={15} strokeWidth={2.4} />
					</IconButton>
					{/* Hangs from the sidebar's top right corner, so it opens leftwards. */}
					<div className="absolute right-0 z-20 mt-2 w-[min(328px,calc(100vw-2rem))] overflow-hidden rounded-panel bg-panel text-left shadow-dialog">
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
			{execution.trigger.kind === "github" && (
				<IconButton
					label="Open what started it"
					variant="bar"
					render={<a href={execution.trigger.url} target="_blank" rel="noreferrer" />}
				>
					<ExternalLink aria-hidden size={15} strokeWidth={2.4} />
				</IconButton>
			)}
			{pod && (
				<IconButton
					label="Routine settings"
					variant="bar"
					render={<Link {...routineThreadLink(pod, execution.routineId)} state={backToChat} />}
				>
					<SettingsIcon />
				</IconButton>
			)}
		</>
	);
}

/** The kind of thread `type` is, when it may open in `frame`: a run only as a page of its own, never beside a chat. */
function openableThreadType(
	type: string | undefined,
	frame: ThreadFrame,
): ChatThreadType | undefined {
	if (type === "collaboration") return type;
	return type === "routine" && frame.kind !== "sidebar" ? type : undefined;
}
