import type RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

/**
 * An agent's desktop in a thread, live: where the browser it drives is shown,
 * and where the person can click and type too if the pod lets them use
 * desktops, or else only watch. Opening it starts the desktop,
 * and the sandbox if it was paused, so the first connection can take a few
 * seconds; it comes over a WebSocket the API relays from the sandbox.
 */
export function DesktopViewerDialog({
	threadId,
	agentId,
	agentName,
	viewOnly,
	open,
	onOpenChange,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
	/** Whether the person may only watch: they don't hold the pod's `useDesktops`. */
	viewOnly: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				// As large as the window allows, keeping the desktop's 16:10 shape and
				// leaving room for the title, up to its own 1280 pixels across.
				className="w-[min(1280px,calc(100vw-2rem),calc((100dvh-9rem)*1.6))] max-w-none gap-3 sm:max-w-none"
			>
				<DialogTitle>{agentName}'s desktop</DialogTitle>
				<DialogDescription>
					{viewOnly
						? "Live from the sandbox. You can watch what the agent does here."
						: "Live from the sandbox. You can use it too, with the agent's browser and sessions, so what you do here is real."}
				</DialogDescription>
				{open && <DesktopScreen threadId={threadId} agentId={agentId} viewOnly={viewOnly} />}
			</DialogContent>
		</Dialog>
	);
}

type Standing = "connecting" | "connected" | "ended" | "idle";

/**
 * How long the desktop stays connected while neither the person nor the agent
 * uses it. A connection holds the sandbox awake, so a forgotten tab would keep
 * it running for as long as the tab stays open.
 */
const IDLE_TIMEOUT_MINUTES = 5;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "wheel", "keydown"] as const;

/**
 * The desktop, scaled to fit and, unless `viewOnly`, taking the person's
 * mouse and keys, for as long as it's mounted and in use: it lets go after {@link IDLE_TIMEOUT_MINUTES}
 * without input from the person or a browser call from the agent.
 */
export function DesktopScreen({
	threadId,
	agentId,
	viewOnly,
}: {
	threadId: string;
	agentId: string;
	/** Shows the desktop without sending input. The API enforces it either way. */
	viewOnly: boolean;
}) {
	const screen = useRef<HTMLDivElement>(null);
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	const lastUsedAt = useRef(Date.now());
	const agentUsing = useDesktopInUse(threadId, agentId);
	const agentUsingNow = useRef(agentUsing);
	useEffect(() => {
		agentUsingNow.current = agentUsing;
	}, [agentUsing]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reconnects.
	useEffect(() => {
		const element = screen.current;
		if (!element) return;
		let viewer: RFB | undefined;
		let unmounted = false;
		setStanding("connecting");
		lastUsedAt.current = Date.now();
		const used = () => {
			lastUsedAt.current = Date.now();
		};
		// Captured before noVNC's own handlers, which stop keys from bubbling.
		for (const event of INPUT_EVENTS) element.addEventListener(event, used, { capture: true });
		const idleCheck = setInterval(() => {
			if (agentUsingNow.current) used();
			if (!viewer || Date.now() - lastUsedAt.current < IDLE_TIMEOUT_MINUTES * 60_000) return;
			const idleViewer = viewer;
			viewer = undefined;
			setStanding("idle");
			idleViewer.disconnect();
		}, IDLE_CHECK_INTERVAL_MS);
		// Loaded only when somebody watches: noVNC is large, and most people never do.
		void import("@novnc/novnc").then(({ default: RFBClient }) => {
			if (unmounted) return;
			const opened = new RFBClient(element, desktopUrl(threadId, agentId));
			viewer = opened;
			opened.scaleViewport = true;
			opened.viewOnly = viewOnly;
			opened.background = "var(--color-background)";
			opened.addEventListener("connect", () => setStanding("connected"));
			opened.addEventListener("disconnect", () => {
				if (viewer === opened) setStanding("ended");
			});
		});
		return () => {
			unmounted = true;
			clearInterval(idleCheck);
			for (const event of INPUT_EVENTS) element.removeEventListener(event, used, { capture: true });
			viewer?.disconnect();
		};
	}, [threadId, agentId, viewOnly, attempt]);

	return (
		<div className="relative aspect-[16/10] w-full overflow-hidden rounded-panel bg-list">
			<div ref={screen} className="absolute inset-0" />
			{standing !== "connected" && (
				<div className="absolute inset-0 grid place-items-center content-center gap-3 px-6 text-center text-muted-foreground text-sm">
					<p>{STANDING_TEXT[standing]}</p>
					{standing === "idle" && (
						<Button variant="outline" onClick={() => setAttempt((count) => count + 1)}>
							Reconnect
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

const STANDING_TEXT: Record<Exclude<Standing, "connected">, string> = {
	connecting: "Starting the desktop…",
	ended: "The desktop couldn't be reached. Close this and open it again to retry.",
	idle: `Disconnected after ${IDLE_TIMEOUT_MINUTES} minutes unused, so the sandbox can pause.`,
};

function desktopUrl(threadId: string, agentId: string) {
	const url = new URL(`${apiBaseUrl}/threads/${threadId}/agents/${agentId}/desktop`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
