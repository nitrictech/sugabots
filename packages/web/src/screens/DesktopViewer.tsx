import type RFB from "@novnc/novnc";
import type { Agent } from "@sugabots/contracts";
import { Monitor } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { IDLE_TIMEOUT_MINUTES, useDesktopInUse, useViewerIdle } from "@/lib/desktop.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { BrowserScreen } from "./BrowserViewer.tsx";

/**
 * An agent's browser opened beside its chat, live, or its whole desktop,
 * where other apps run. Opening one starts it, and the sandbox if it was
 * paused, so the first connection can take a few seconds; it comes over
 * WebSockets the API relays from the sandbox. The person watches until they
 * take over, if the pod lets them use desktops, and can hand control back.
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
	const [view, setView] = useState<"browser" | "desktop">("browser");
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
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
				{/* As large as the room allows, keeping the desktop's 16:10 shape, up to its own 1280 pixels across. */}
				<div className="w-[min(1280px,100%,calc((100dvh-13rem)*1.6))]">
					{view === "browser" ? (
						<BrowserScreen threadId={threadId} agentId={agent.id} viewOnly={!inControl} />
					) : (
						<LiveScreen
							threadId={threadId}
							agentId={agent.id}
							what="desktop"
							viewOnly={!inControl}
						/>
					)}
				</div>
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
					<SegmentedControl
						label="What to show"
						options={[
							{ value: "browser", label: "Browser" },
							{ value: "desktop", label: "Desktop" },
						]}
						value={view}
						onChange={setView}
					/>
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
 * see it at work without leaving the chat. Clicking it opens the browser
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
				<LiveScreen threadId={threadId} agentId={agentId} what="browser" viewOnly />
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

export type Standing = "connecting" | "connected" | "ended" | "idle";

/**
 * The agent's whole desktop or its browser's display, live over VNC, scaled
 * to fit and, unless `viewOnly`, taking the person's mouse and keys, for as
 * long as it's mounted and in use: it lets go after {@link IDLE_TIMEOUT_MINUTES}
 * without input from the person or a browser call from the agent. A person in
 * control of the browser resizes its display to fit, so pages lay out for the
 * room they're shown in. `above` is shown over the screen while it's in use,
 * and mounted again on reconnecting.
 */
export function LiveScreen({
	threadId,
	agentId,
	what,
	viewOnly,
	above,
}: {
	threadId: string;
	agentId: string;
	what: "desktop" | "browser";
	/** Shows the screen without sending input. The API enforces it either way. */
	viewOnly: boolean;
	above?: ReactNode;
}) {
	const root = useRef<HTMLDivElement>(null);
	const screen = useRef<HTMLDivElement>(null);
	const connected = useRef<RFB | undefined>(undefined);
	const viewOnlyNow = useRef(viewOnly);
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	const idle = useViewerIdle(root, threadId, agentId, attempt);
	const resizesDisplay = (viewOnly: boolean) => what === "browser" && !viewOnly;
	// Taking over or handing back switches input on the open connection, without reconnecting.
	useEffect(() => {
		viewOnlyNow.current = viewOnly;
		if (!connected.current) return;
		connected.current.viewOnly = viewOnly;
		connected.current.resizeSession = resizesDisplay(viewOnly);
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reconnects.
	useEffect(() => {
		const element = screen.current;
		if (!element) return;
		let unmounted = false;
		setStanding("connecting");
		// Loaded only when somebody watches: noVNC is large, and most people never do.
		void import("@novnc/novnc").then(({ default: RFBClient }) => {
			if (unmounted) return;
			const opened = new RFBClient(element, viewerUrl(threadId, agentId, what));
			connected.current = opened;
			opened.scaleViewport = true;
			opened.viewOnly = viewOnlyNow.current;
			opened.resizeSession = resizesDisplay(viewOnlyNow.current);
			opened.background = "var(--color-background)";
			opened.addEventListener("connect", () => setStanding("connected"));
			opened.addEventListener("disconnect", () => {
				if (connected.current === opened) setStanding("ended");
			});
		});
		return () => {
			unmounted = true;
			const viewer = connected.current;
			connected.current = undefined;
			viewer?.disconnect();
		};
	}, [threadId, agentId, what, attempt]);

	useEffect(() => {
		if (!idle) return;
		const viewer = connected.current;
		connected.current = undefined;
		setStanding("idle");
		viewer?.disconnect();
	}, [idle]);

	return (
		<div ref={root} className="flex w-full flex-col overflow-hidden rounded-panel bg-list">
			{!idle && <Fragment key={attempt}>{above}</Fragment>}
			<div className="relative aspect-[16/10] w-full">
				<div ref={screen} className="absolute inset-0" />
				<StandingOverlay
					standing={standing}
					what={what}
					onReconnect={() => setAttempt((count) => count + 1)}
				/>
			</div>
		</div>
	);
}

/** What a viewer that isn't showing anything says instead, with a way back from idle. */
export function StandingOverlay({
	standing,
	what,
	onReconnect,
}: {
	standing: Standing;
	what: "desktop" | "browser";
	onReconnect: () => void;
}) {
	if (standing === "connected") return null;
	const text = {
		connecting: `Starting the ${what}…`,
		ended: `The ${what} couldn't be reached. Close it and open it again to retry.`,
		idle: `Disconnected after ${IDLE_TIMEOUT_MINUTES} minutes unused, so the sandbox can pause.`,
	}[standing];
	return (
		<div className="absolute inset-0 grid place-items-center content-center gap-3 px-6 text-center text-muted-foreground text-sm">
			<p>{text}</p>
			{standing === "idle" && (
				<Button variant="outline" onClick={onReconnect}>
					Reconnect
				</Button>
			)}
		</div>
	);
}

/** The API's WebSocket for the agent's desktop, its browser's display, or its browser's tabs. */
export function viewerUrl(
	threadId: string,
	agentId: string,
	what: "desktop" | "browser" | "browser/tabs",
) {
	const url = new URL(`${apiBaseUrl}/threads/${threadId}/agents/${agentId}/${what}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
