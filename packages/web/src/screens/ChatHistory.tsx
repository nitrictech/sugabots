import type { Agent, ChatHistoryEntry } from "@sugabots/contracts";
import { CircleAlert, MessageSquare, X } from "lucide-react";
import { useEffect } from "react";
import { useChatHistory } from "@/lib/chats.ts";
import { Button } from "@/ui/button.tsx";
import { HistoryThreadTile } from "./ChatThreadChrome.tsx";

export function ChatHistory({
	chatId,
	agent,
	selectedThreadId,
	onClose,
	onOpen,
}: {
	chatId: string;
	agent: Agent;
	selectedThreadId?: string;
	onClose: () => void;
	onOpen: (threadId: string) => void;
}) {
	const history = useChatHistory(chatId);
	const groups = groupHistory(history.entries);

	useEffect(() => {
		function closeOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		}
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return (
		<aside
			aria-label="Chat history"
			className="chat-history-panel flex w-[296px] shrink-0 flex-col border-border-subtle border-l bg-background"
		>
			<header className="shrink-0 px-4 pb-2 pt-4">
				<div className="flex items-center gap-2">
					<h2 className="m-0 min-w-0 flex-1 font-semibold text-subtle-foreground text-xs uppercase tracking-[0.06em]">
						Chat history
					</h2>
					<button
						type="button"
						aria-label="Close Chat history"
						onClick={onClose}
						className="focus-ring grid size-8 place-items-center rounded-lg bg-sunken text-muted-foreground hover:text-heading"
					>
						<X size={15} />
					</button>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				{history.isPending ? (
					<HistoryLoading />
				) : history.isError ? (
					<HistoryError onRetry={() => void history.refetch()} />
				) : groups.length === 0 ? (
					<HistoryEmpty agentName={agent.name} />
				) : (
					<>
						{groups.map((group) => (
							<section key={group.key} aria-labelledby={`history-${group.key}`}>
								<h3
									id={`history-${group.key}`}
									className="m-0 flex items-center gap-2 px-2 pb-1.5 pt-3.5 font-semibold text-2xs text-subtle-foreground uppercase tracking-[0.07em]"
								>
									<span>{group.label}</span>
									<span aria-hidden className="h-px flex-1 bg-border-subtle" />
								</h3>
								{group.entries.map((entry) => (
									<button
										key={entry.threadId}
										type="button"
										aria-label={entry.title}
										onClick={() => onOpen(entry.threadId)}
										className="focus-ring mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-sunken data-[selected=true]:bg-[#f1f6f3]"
										data-selected={entry.threadId === selectedThreadId}
									>
										<HistoryThreadTile
											type={entry.type}
											triggerKind={entry.routineExecution?.triggerKind}
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium text-heading text-[13.5px]">
												{entry.title}
											</span>
											{entry.routineExecution && (
												<span className="block truncate pt-0.5 text-subtle-foreground text-xs">
													{entry.routineExecution.routineName} ·{" "}
													{triggerLabel(entry.routineExecution.triggerKind)}
												</span>
											)}
										</span>
									</button>
								))}
							</section>
						))}
						{history.hasNextPage && (
							<Button
								variant="link"
								size="bare"
								className="mx-2 mt-3"
								disabled={history.isFetchingNextPage}
								onClick={() => void history.fetchNextPage()}
							>
								{history.isFetchingNextPage ? "Loading…" : "Load older threads"}
							</Button>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

function triggerLabel(kind: "cron" | "webhook" | "manual"): string {
	if (kind === "cron") return "Scheduled";
	if (kind === "webhook") return "Webhook";
	return "Manual run";
}

function HistoryLoading() {
	return (
		<div className="flex flex-col gap-3 px-1 pt-4" role="status" aria-label="Loading Chat history">
			{[0, 1, 2].map((value) => (
				<div key={value} className="flex gap-2.5">
					<span className="size-[26px] animate-pulse rounded-lg bg-muted" />
					<span className="flex-1">
						<span className="block h-3 w-4/5 animate-pulse rounded bg-muted" />
						<span className="mt-2 block h-2.5 w-1/2 animate-pulse rounded bg-sunken" />
					</span>
				</div>
			))}
			<span className="text-subtle-foreground text-xs">Loading threads…</span>
		</div>
	);
}

function HistoryEmpty({ agentName }: { agentName: string }) {
	return (
		<div className="grid h-full place-content-center px-5 text-center">
			<span className="mx-auto grid size-10 place-items-center rounded-xl bg-sunken text-subtle-foreground">
				<MessageSquare size={18} />
			</span>
			<h3 className="mb-0 mt-2.5 font-semibold text-heading text-base">No activity yet</h3>
			<p className="m-0 max-w-56 pt-1 text-muted-foreground text-sm leading-relaxed">
				Collaborations and routine runs for {agentName} will appear here.
			</p>
		</div>
	);
}

function HistoryError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="grid h-full place-content-center px-5 text-center">
			<span className="mx-auto grid size-10 place-items-center rounded-xl bg-[#fbeeec] text-[#a4453a]">
				<CircleAlert size={18} />
			</span>
			<h3 className="mb-0 mt-2.5 font-semibold text-heading text-base">Couldn't load history</h3>
			<p className="m-0 pt-1 text-muted-foreground text-sm">
				The chat itself is fine. Only this list failed.
			</p>
			<Button variant="ghost" size="sm" className="mx-auto mt-3 text-primary" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}

function groupHistory(entries: ChatHistoryEntry[]) {
	const groups = new Map<string, { label: string; entries: ChatHistoryEntry[] }>();
	for (const entry of entries) {
		const date = new Date(entry.latestActivityAt);
		const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
		const group = groups.get(key) ?? { label: relativeDay(date), entries: [] };
		group.entries.push(entry);
		groups.set(key, group);
	}
	return [...groups].map(([key, group]) => ({ key, ...group }));
}

function relativeDay(date: Date): string {
	const today = new Date();
	if (sameDay(date, today)) return "Today";
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (sameDay(date, yesterday)) return "Yesterday";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
	}).format(date);
}

function sameDay(left: Date, right: Date) {
	return left.toDateString() === right.toDateString();
}
