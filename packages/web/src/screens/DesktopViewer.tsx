import type RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

/**
 * An agent's desktop in a thread, live: where the browser it drives is shown,
 * and where the person can click and type too. Opening it starts the desktop,
 * and the sandbox if it was paused, so the first connection can take a few
 * seconds; it comes over a WebSocket the API relays from the sandbox.
 */
export function DesktopViewerDialog({
	threadId,
	agentId,
	agentName,
	open,
	onOpenChange,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
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
					Live from the sandbox. You can use it too, with the agent's browser and sessions, so what
					you do here is real.
				</DialogDescription>
				{open && <DesktopScreen threadId={threadId} agentId={agentId} />}
			</DialogContent>
		</Dialog>
	);
}

type Standing = "connecting" | "connected" | "ended";

/** The desktop, scaled to fit and taking the person's mouse and keys, for as long as it's mounted. */
export function DesktopScreen({ threadId, agentId }: { threadId: string; agentId: string }) {
	const screen = useRef<HTMLDivElement>(null);
	const [standing, setStanding] = useState<Standing>("connecting");

	useEffect(() => {
		let viewer: RFB | undefined;
		let unmounted = false;
		setStanding("connecting");
		// Loaded only when somebody watches: noVNC is large, and most people never do.
		void import("@novnc/novnc").then(({ default: RFBClient }) => {
			if (unmounted || !screen.current) return;
			viewer = new RFBClient(screen.current, desktopUrl(threadId, agentId));
			viewer.scaleViewport = true;
			viewer.background = "var(--color-background)";
			viewer.addEventListener("connect", () => setStanding("connected"));
			viewer.addEventListener("disconnect", () => setStanding("ended"));
		});
		return () => {
			unmounted = true;
			viewer?.disconnect();
		};
	}, [threadId, agentId]);

	return (
		<div className="relative aspect-[16/10] w-full overflow-hidden rounded-panel bg-list">
			<div ref={screen} className="absolute inset-0" />
			{standing !== "connected" && (
				<p className="absolute inset-0 grid place-items-center px-6 text-center text-muted-foreground text-sm">
					{standing === "connecting"
						? "Starting the desktop…"
						: "The desktop couldn't be reached. Close this and open it again to retry."}
				</p>
			)}
		</div>
	);
}

function desktopUrl(threadId: string, agentId: string) {
	const url = new URL(`${apiBaseUrl}/threads/${threadId}/agents/${agentId}/desktop`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
