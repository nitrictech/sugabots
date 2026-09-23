import type { SessionUser, ThreadDetails, ThreadParticipant } from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { useLayoutEffect, useRef } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { useThreadEvents } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { SurfaceColumn, SurfaceGlow } from "@/ui/surface.tsx";
import { ThreadConversation } from "./ThreadConversation.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { ThreadSummaryDisclosure, ThreadSummaryRail } from "./ThreadSummary.tsx";

const FOLLOW_LATEST_DISTANCE_PX = 96;

/**
 * Everyone a mention in this thread could name: the people and agents who have
 * spoken, plus the rest of the pod's crew.
 *
 * The crew matters because the first time an agent is named it has not joined
 * yet — an agent calling out to `@aquaman`, or a person asking for one — and
 * reading names against the participants alone leaves exactly those unrecognised.
 */
function mentionableIn(details: ThreadDetails): ThreadParticipant[] {
	const joined = new Set(details.participants.map((participant) => participant.id));
	return [...details.participants, ...details.crew.filter((member) => !joined.has(member.id))];
}
type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/**
 * One thread: its header, read-only conversation and summary rail.
 *
 * `embedded` is a collaboration shown inside its parent Chat. The surrounding
 * card supplies the header, so this keeps only the conversation itself.
 */
export function ThreadPage({
	threadId,
	user,
	embedded = false,
}: {
	threadId: string;
	user: SessionUser;
	embedded?: boolean;
}) {
	const query = useThread(threadId);
	useThreadEvents(threadId);
	const details = query.data;
	const host = details?.participants.find(
		(participant): participant is AgentParticipant =>
			participant.kind === "agent" && participant.id === details.thread.hostAgentId,
	);
	const conversationViewport = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	async function loadOlder() {
		const viewport = conversationViewport.current;
		const previousHeight = viewport?.scrollHeight ?? 0;
		const previousTop = viewport?.scrollTop ?? 0;
		followLatest.current = false;
		await query.loadOlder();
		requestAnimationFrame(() => {
			const current = conversationViewport.current;
			if (current) {
				current.scrollTop = previousTop + current.scrollHeight - previousHeight;
			}
		});
	}

	useLayoutEffect(() => {
		const viewport = conversationViewport.current;
		if (viewport && followLatest.current) {
			viewport.scrollTop = viewport.scrollHeight;
		}
	});

	useLayoutEffect(() => {
		function followAfterResize() {
			requestAnimationFrame(() => {
				const viewport = conversationViewport.current;
				if (viewport && followLatest.current) {
					viewport.scrollTop = viewport.scrollHeight;
				}
			});
		}
		window.addEventListener("resize", followAfterResize);
		return () => window.removeEventListener("resize", followAfterResize);
	}, []);
	useFollowContentGrowth(conversationViewport, followLatest);

	if (query.isPending) {
		return null;
	}
	if (!details) {
		const notFound = isApiFailure(query.error) && query.error._tag === "NotFound";
		return (
			<EmptyState
				title={notFound || !query.error ? "No such thread here" : "Could not load this thread"}
			>
				{notFound || !query.error
					? "This thread is unavailable. It may have been removed, or you may no longer be a member of its pod."
					: "The API did not answer. Reload, or check that it is running."}
			</EmptyState>
		);
	}
	if (!host) {
		return (
			<EmptyState title="Could not load this thread">
				The thread history is missing its host agent. Reload, or check that the thread data is
				intact.
			</EmptyState>
		);
	}

	return (
		<div
			className="agent-tint relative flex min-h-0 flex-1 flex-col"
			style={{ ["--agent-hue" as string]: host.hue }}
		>
			{!embedded && <SurfaceGlow hue={host.hue} />}
			{!embedded && <ThreadHeader details={details} />}

			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
					<ScrollArea
						className="relative min-h-0 min-w-0 flex-1"
						viewportRef={conversationViewport}
						onViewportScroll={(event) => {
							const viewport = event.currentTarget;
							followLatest.current =
								viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
								FOLLOW_LATEST_DISTANCE_PX;
						}}
					>
						<SurfaceColumn
							className={
								embedded
									? "flex max-w-none flex-col px-4 py-4"
									: "flex max-w-none flex-col px-5 py-6 md:px-[30px] md:py-7"
							}
						>
							{!embedded && <ThreadSummaryDisclosure details={details} host={host} />}
							{query.loadOlderError && <Alert>{failureMessage(query.loadOlderError)}</Alert>}
							{details.olderMessagesCursor && (
								<Button
									variant="link"
									size="bare"
									className="self-center"
									disabled={query.isLoadingOlder}
									onClick={() => void loadOlder().catch(() => {})}
								>
									{query.isLoadingOlder ? "Loading…" : "Load older"}
								</Button>
							)}
							<ThreadConversation
								messages={details.messages}
								host={host}
								isRunning={details.thread.status === "running"}
								mentionable={mentionableIn(details)}
								user={user}
								hostAgentOnRight={details.thread.type === "collaboration"}
								dividers={!embedded}
								podId={details.thread.podId}
								canApproveToolCalls={details.capabilities?.approveToolCalls}
								canAlwaysAllowToolCalls={details.capabilities?.alwaysAllowToolCalls}
							/>
						</SurfaceColumn>
					</ScrollArea>
				</div>
				{!embedded && <ThreadSummaryRail details={details} host={host} />}
			</div>
		</div>
	);
}
