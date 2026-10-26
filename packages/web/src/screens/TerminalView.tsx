import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
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
		const background = resolvedColor(host, "var(--color-panel)");
		const foreground = resolvedColor(host, "var(--color-foreground)");
		const opened = new Terminal({
			cursorBlink: true,
			disableStdin: viewOnlyNow.current,
			fontFamily: getComputedStyle(host).getPropertyValue("--font-mono"),
			fontSize: 13,
			theme: {
				...(isDark(background) ? DARK_COLORS : LIGHT_COLORS),
				background,
				foreground,
				cursor: foreground,
				selectionBackground: resolvedColor(host, "var(--color-hover)"),
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

	return (
		<>
			<div ref={element} className="absolute inset-0 bg-panel p-2" />
			{viewOnly && (
				<p className="pointer-events-none absolute right-3 bottom-3 m-0 rounded-full bg-chip px-3 py-1 text-muted-foreground text-xs">
					Take over to type here
				</p>
			)}
		</>
	);
}

/**
 * The terminal's 16 colours, matching the app's palette. Black and white
 * trade places between the themes, so neither ends up the colour of the
 * window behind it.
 */
const ANSI_COLORS = {
	red: "#f43f5e",
	green: "#22c55e",
	yellow: "#facc15",
	blue: "#7c8cff",
	magenta: "#a78bfa",
	cyan: "#2dd4bf",
	brightRed: "#fb7185",
	brightGreen: "#4ade80",
	brightYellow: "#fde047",
	brightBlue: "#aebbff",
	brightMagenta: "#c4b5fd",
	brightCyan: "#5eead4",
} satisfies ITheme;
const DARK_COLORS: ITheme = {
	...ANSI_COLORS,
	black: "#15161a",
	white: "#dfe1e6",
	brightBlack: "#5b616c",
	brightWhite: "#ffffff",
};
const LIGHT_COLORS: ITheme = {
	...ANSI_COLORS,
	black: "#16171b",
	white: "#5f646e",
	brightBlack: "#9096a1",
	brightWhite: "#16171b",
};

/**
 * `color` as the browser draws it, in the element's theme: xterm can't read
 * the app's colour tokens, which pick between their light and dark values.
 */
function resolvedColor(element: HTMLElement, color: string) {
	const probe = document.createElement("span");
	probe.style.color = color;
	element.append(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	return resolved;
}

/** Whether an `rgb(…)` colour is a dark one. */
function isDark(rgb: string) {
	const [red = 0, green = 0, blue = 0] = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
	return red * 0.299 + green * 0.587 + blue * 0.114 < 128;
}
