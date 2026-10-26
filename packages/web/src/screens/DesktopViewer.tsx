import type { Agent } from "@sugabots/contracts";
import { Monitor } from "lucide-react";
import { useRef, useState } from "react";
import { IDLE_TIMEOUT_MINUTES, useDesktopInUse, useViewerIdle } from "@/lib/desktop.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { AgentDesktop } from "./Desktop.tsx";
import { type Standing, StandingOverlay, VncView, windowUrl } from "./VncView.tsx";

/**
 * An agent's desktop opened beside its chat, live: the browser it drives and
 * its other apps, each in a window. Opening it starts the browser, and the
 * sandbox if it was paused, so the first connection can take a few seconds;
 * it comes over WebSockets the API relays from the sandbox. The person
 * watches until they take over, if the pod lets them use desktops, and can
 * hand control back.
 */
export function DesktopStage({
	threadId,
	agent,
	mayUse,
	onClose,
}: {
	threadId: string;
	agent: Agent;
	/** Whether the person holds the pod's `useDesktops`, and so may take over. */
	mayUse: boolean;
	onClose: () => void;
}) {
	const [inControl, setInControl] = useState(false);
	const agentUsing = useDesktopInUse(threadId, agent.id);
	return (
		<Stage
			label={`${agent.name}'s desktop`}
			icon={
				<StageMark>
					<Monitor strokeWidth={2} />
				</StageMark>
			}
			title={`${agent.name}'s desktop`}
			byline="Live from the sandbox"
			onClose={onClose}
		>
			<div className="flex min-h-0 flex-1 flex-col items-center gap-4">
				<AgentDesktop threadId={threadId} agentId={agent.id} viewOnly={!inControl} />
				<div className="flex max-w-full items-center gap-2.5 rounded-full border border-border-strong bg-panel py-1.5 pr-1.5 pl-3 text-sm">
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={22}
						className="shrink-0"
					/>
					<span className="min-w-0 text-soft-foreground">
						{!mayUse ? (
							<>You can watch what {agent.name} does here.</>
						) : inControl ? (
							<>
								<b className="font-semibold text-foreground">You</b> have control. What you do here
								is real.
							</>
						) : agentUsing ? (
							<>
								<b className="font-semibold text-foreground">{agent.name}</b> has control
							</>
						) : (
							<>Watching</>
						)}
					</span>
					{mayUse && (
						<Button
							size="sm"
							variant={inControl ? "secondary" : "default"}
							onClick={() => setInControl(!inControl)}
						>
							{inControl ? "Hand back" : "Take over"}
						</Button>
					)}
				</div>
			</div>
		</Stage>
	);
}

/**
 * The agent's browser in the reply that is using it, watch-only, so people
 * see it at work without leaving the chat. Clicking it opens the desktop
 * beside the chat.
 */
export function LiveDesktopCard({
	threadId,
	agentId,
	agentName,
	onOpen,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
	onOpen: () => void;
}) {
	return (
		<article
			aria-label={`${agentName}'s screen`}
			className="overflow-hidden rounded-[12px] border border-border bg-panel"
		>
			<div className="relative">
				<LiveScreen threadId={threadId} agentId={agentId} window="browser" />
				<button
					type="button"
					onClick={onOpen}
					aria-label={`Open ${agentName}'s desktop`}
					className="focus-ring absolute inset-0 cursor-zoom-in"
				/>
			</div>
			<p className="m-0 flex items-center gap-2 px-3 py-2 text-[12.5px] text-muted-foreground">
				<span aria-hidden className="relative flex size-2">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
					<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
				</span>
				{agentName} is using its browser
			</p>
		</article>
	);
}

/**
 * One window of the agent's desktop on its own, watch-only, scaled into a
 * 16:10 frame, for as long as it's mounted and in use: it lets go after
 * {@link IDLE_TIMEOUT_MINUTES} without input from the person or a browser
 * call from the agent.
 */
export function LiveScreen({
	threadId,
	agentId,
	window,
}: {
	threadId: string;
	agentId: string;
	/** `browser`, `files`, or the number of a display the agent started. */
	window: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	const idle = useViewerIdle(root, threadId, agentId, attempt);
	return (
		<div
			ref={root}
			className="relative aspect-[16/10] w-full overflow-hidden rounded-panel bg-list"
		>
			{!idle && (
				<VncView
					key={attempt}
					url={windowUrl(threadId, agentId, window)}
					viewOnly
					onStanding={setStanding}
				/>
			)}
			<StandingOverlay
				standing={idle ? "idle" : standing}
				what={window === "browser" ? "browser" : "window"}
				onReconnect={() => setAttempt((count) => count + 1)}
			/>
		</div>
	);
}
