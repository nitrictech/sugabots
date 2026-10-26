import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { desktopServerUrl } from "./VncView.tsx";

/**
 * The agent's desktop's terminal, filling its parent: one shell shared by
 * everyone viewing the desktop, starting in the thread's folder. Unless
 * `viewOnly`, the person's keys go to it and its size follows the window's;
 * the sandbox ignores both from a viewer who only watches.
 */
export function TerminalView({
	threadId,
	agentId,
	viewOnly,
}: {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
}) {
	const element = useRef<HTMLDivElement>(null);
	const viewOnlyNow = useRef(viewOnly);
	const terminal = useRef<Terminal | undefined>(undefined);
	useEffect(() => {
		viewOnlyNow.current = viewOnly;
		if (terminal.current) terminal.current.options.disableStdin = viewOnly;
	}, [viewOnly]);

	useEffect(() => {
		const host = element.current;
		if (!host) return;
		const colors = getComputedStyle(host);
		const opened = new Terminal({
			cursorBlink: true,
			disableStdin: viewOnlyNow.current,
			fontFamily: colors.getPropertyValue("--font-mono"),
			fontSize: 13,
			theme: {
				background: colors.getPropertyValue("--color-panel"),
				foreground: colors.getPropertyValue("--color-foreground"),
				cursor: colors.getPropertyValue("--color-foreground"),
			},
		});
		terminal.current = opened;
		const fit = new FitAddon();
		opened.loadAddon(fit);
		opened.open(host);
		const socket = new WebSocket(desktopServerUrl(threadId, agentId, "terminal"));
		const send = (message: object) => {
			if (!viewOnlyNow.current && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		};
		const resize = () => {
			fit.fit();
			send({ type: "resize", cols: opened.cols, rows: opened.rows });
		};
		socket.onopen = resize;
		socket.onmessage = (event) => opened.write(String(event.data));
		opened.onData((data) => send({ type: "input", data }));
		const sized = new ResizeObserver(resize);
		sized.observe(host);
		return () => {
			sized.disconnect();
			socket.close();
			opened.dispose();
			terminal.current = undefined;
		};
	}, [threadId, agentId]);

	return <div ref={element} className="absolute inset-0 bg-panel p-2" />;
}
