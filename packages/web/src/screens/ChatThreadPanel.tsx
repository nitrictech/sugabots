import type {
	ChatHistoryEntry,
	RoutineExecution,
	SessionUser,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Braces, ChevronLeft, CircleAlert, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { useThreadEvents } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import type { ChatThreadType } from "./ChatActivityRow.tsx";
import { HistoryThreadTile } from "./ChatThreadChrome.tsx";
import { ThreadConversation } from "./ThreadConversation.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function ChatThreadPanel({
	chatId,
	threadId,
	entry,
	history,
	user,
	onClose,
	onOpenThread,
}: {
	chatId: string;
	threadId: string;
	entry?: ChatHistoryEntry;
	history: ChatHistoryEntry[];
	user: SessionUser;
	onClose: () => void;
	onOpenThread: (threadId: string) => void;
}) {
	const query = useThread(threadId);
	useThreadEvents(threadId);
	const panel = useRef<HTMLElement>(null);
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

	function trapFocus(event: KeyboardEvent<HTMLElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = [
			...(panel.current?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), textarea, [href], [tabindex]:not([tabindex="-1"])',
			) ?? []),
		];
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		}
		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	}

	return (
		<div className="absolute inset-0 z-30 flex justify-end" role="presentation">
			<button
				type="button"
				aria-label="Close thread"
				onClick={onClose}
				className="absolute inset-0 cursor-default bg-[rgba(34,35,31,.05)]"
			/>
			<aside
				ref={panel}
				onKeyDown={trapFocus}
				aria-labelledby="thread-panel-heading"
				className="chat-thread-panel relative flex w-3/4 min-w-[560px] max-w-[820px] flex-col overflow-hidden rounded-l-[18px] border-border border-l bg-card shadow-[-20px_0_44px_rgba(40,35,30,.12)]"
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
						<header className="shrink-0 border-border-subtle border-b px-[18px] pb-[13px] pt-4">
							{parentRoutine ? (
								<button
									type="button"
									onClick={() => onOpenThread(parentRoutine.threadId)}
									className="focus-ring mb-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#f1f6f3] px-2.5 py-1.5 font-semibold text-primary text-xs"
								>
									<ChevronLeft aria-hidden size={13} />
									Back to Routine
								</button>
							) : (
								<button
									type="button"
									onClick={onClose}
									className="focus-ring mb-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#f1f6f3] px-2.5 py-1.5 font-semibold text-primary text-xs md:hidden"
								>
									<ChevronLeft aria-hidden size={13} />
									Chat
								</button>
							)}
							<div className="flex items-center gap-3">
								<HistoryThreadTile
									type={type}
									triggerKind={routineExecution?.trigger.kind}
									size={16}
								/>
								<h2
									ref={heading}
									tabIndex={-1}
									id="thread-panel-heading"
									className="m-0 min-w-0 flex-1 truncate font-semibold text-[16.5px] text-heading outline-none"
								>
									{details.thread.title}
								</h2>
								{type === "routine" && routineExecution && (
									<RoutineHeaderActions execution={routineExecution} podId={details.thread.podId} />
								)}
								<button
									type="button"
									aria-label="Close thread (Escape)"
									onClick={onClose}
									className="focus-ring grid size-[30px] shrink-0 place-items-center rounded-lg bg-sunken text-muted-foreground hover:text-heading"
								>
									<X size={16} />
								</button>
							</div>
						</header>
						<div
							ref={timeline}
							role="log"
							aria-label="Thread messages"
							className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
						>
							{query.loadOlderError && (
								<p role="alert" className="m-0 pb-3 text-destructive text-sm">
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
									className="mb-4 flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2.5 text-destructive text-sm"
								>
									<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
									{routineExecution.error}
								</p>
							)}
							<ThreadConversation
								messages={
									type === "routine"
										? details.messages.filter(
												(message) => message.author.kind !== "routine_trigger",
											)
										: details.messages
								}
								host={host}
								isRunning={details.thread.status === "running"}
								mentionable={[...details.participants, ...details.crew]}
								user={user}
								hostAgentOnRight={type === "collaboration"}
								dividers={false}
								onOpenCollaboration={onOpenThread}
								threadEntries={history}
								podId={details.thread.podId}
								canApproveToolCalls={details.capabilities?.approveToolCalls}
								canAlwaysAllowToolCalls={details.capabilities?.alwaysAllowToolCalls}
							/>
						</div>
					</>
				)}
			</aside>
		</div>
	);
}

function RoutineHeaderActions({
	execution,
	podId,
}: {
	execution: RoutineExecution;
	podId: string;
}) {
	return (
		<div className="flex items-center gap-1">
			{execution.trigger.kind === "webhook" && (
				<details className="group relative">
					<summary
						aria-label="View webhook payload"
						className="focus-ring grid size-[30px] cursor-pointer list-none place-items-center rounded-lg text-muted-foreground hover:bg-sunken hover:text-heading [&::-webkit-details-marker]:hidden"
					>
						<Braces aria-hidden size={15} />
					</summary>
					<div className="absolute right-0 z-20 mt-2 w-[min(360px,calc(100vw-3rem))] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
						{execution.trigger.idempotencyKey && (
							<div className="border-border-subtle border-b px-3 py-2 text-subtle-foreground text-xs">
								<span className="pr-2 font-medium">Idempotency key</span>
								<code>{execution.trigger.idempotencyKey}</code>
							</div>
						)}
						<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-sunken px-3 py-2.5 font-mono text-xs leading-relaxed">
							{JSON.stringify(execution.trigger.payload, null, 2)}
						</pre>
					</div>
				</details>
			)}
			<Link
				to="/settings/pods/$pod/agents/$agent"
				params={{ pod: podId, agent: execution.agentId }}
				search={{ tab: "routines" }}
				aria-label="View routine definition"
				className="focus-ring grid size-[30px] place-items-center rounded-lg text-muted-foreground hover:bg-sunken hover:text-primary"
			>
				<ArrowUpRight aria-hidden size={15} />
			</Link>
		</div>
	);
}

function openableThreadType(type: string | undefined): ChatThreadType | undefined {
	return type === "collaboration" || type === "routine" ? type : undefined;
}
