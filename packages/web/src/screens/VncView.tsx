import type RFB from "@novnc/novnc";
import { useEffect, useRef } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { IDLE_TIMEOUT_MINUTES } from "@/lib/desktop.ts";
import { Button } from "@/ui/button.tsx";

export type Standing = "connecting" | "connected" | "ended" | "idle";

/**
 * A display over VNC from the API's WebSocket at `url`, filling its parent,
 * scaled to fit, connected for as long as it's mounted. Unless `viewOnly`, it
 * takes the person's mouse and keys. The desktop server, not VNC, sizes the
 * display to its window, so it fits whether the person is in control or not.
 */
export function VncView({
	url,
	viewOnly,
	onStanding,
}: {
	url: string;
	/** Shows the display without sending input. The API enforces it either way. */
	viewOnly: boolean;
	onStanding?: (standing: Standing) => void;
}) {
	const screen = useRef<HTMLDivElement>(null);
	const connected = useRef<RFB | undefined>(undefined);
	const viewOnlyNow = useRef(viewOnly);
	const onStandingNow = useRef(onStanding);
	onStandingNow.current = onStanding;
	// Taking over or handing back switches input on the open connection, without reconnecting.
	useEffect(() => {
		viewOnlyNow.current = viewOnly;
		if (!connected.current) return;
		connected.current.viewOnly = viewOnly;
	}, [viewOnly]);

	useEffect(() => {
		const element = screen.current;
		if (!element) return;
		let unmounted = false;
		onStandingNow.current?.("connecting");
		// Loaded only when somebody watches: noVNC is large, and most people never do.
		void import("@novnc/novnc").then(({ default: RFBClient }) => {
			if (unmounted) return;
			const opened = new RFBClient(element, url);
			connected.current = opened;
			opened.scaleViewport = true;
			opened.viewOnly = viewOnlyNow.current;
			opened.background = "var(--color-background)";
			opened.addEventListener("connect", () => onStandingNow.current?.("connected"));
			opened.addEventListener("disconnect", () => {
				if (connected.current === opened) onStandingNow.current?.("ended");
			});
		});
		return () => {
			unmounted = true;
			const viewer = connected.current;
			connected.current = undefined;
			viewer?.disconnect();
		};
	}, [url]);

	return <div ref={screen} className="absolute inset-0" />;
}

/** What a viewer that isn't showing anything says instead, with a way back from idle. */
export function StandingOverlay({
	standing,
	what,
	onReconnect,
}: {
	standing: Standing;
	what: "desktop" | "browser" | "window";
	onReconnect: () => void;
}) {
	if (standing === "connected") return null;
	const text = {
		connecting: what === "window" ? "Opening the window…" : `Starting the ${what}…`,
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

/** The API's WebSocket for the display of one of the agent's desktop's windows. */
export function windowUrl(threadId: string, agentId: string, window: string) {
	return webSocketUrl(`/threads/${threadId}/agents/${agentId}/windows/${window}`);
}

/** The API's WebSocket for one of what the agent's desktop's server serves. */
export function desktopServerUrl(
	threadId: string,
	agentId: string,
	channel: "tabs" | "terminal" | "files" | "windows",
) {
	return webSocketUrl(`/threads/${threadId}/agents/${agentId}/desktop/${channel}`);
}

function webSocketUrl(path: string) {
	const url = new URL(`${apiBaseUrl}${path}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
