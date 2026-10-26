import { botColors } from "@sugabots/avatars";
import type { Agent } from "@sugabots/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useViewerIdle } from "@/lib/desktop.ts";
import { useResolvedTheme } from "@/lib/theme.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import {
	DesktopWindow,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
	type Placement,
	type WindowFrame,
	WindowTitle,
} from "./DesktopWindow.tsx";
import { AppIcon, BrowserIcon, FilesIcon, TerminalIcon } from "./DockIcons.tsx";
import { FilesWindow } from "./FilesWindow.tsx";
import { TerminalView } from "./TerminalView.tsx";
import {
	desktopServerUrl,
	type Standing,
	StandingOverlay,
	VncView,
	windowUrl,
} from "./VncView.tsx";

/** One of the desktop's windows that runs on a display in the sandbox, as its server lists them. */
export interface DisplayWindow {
	/** `browser`, or the number of a display the agent started. */
	id: string;
	kind: "browser" | "app";
	/** The title of the window in front on its display, if it has one. */
	title: string;
}

/** The desktop's windows drawn here rather than shown from a display: its terminal and file browser. */
type LocalWindowKind = "terminal" | "files";

/** Every window the desktop can show. */
type DesktopWindowKind = DisplayWindow["kind"] | LocalWindowKind;

interface ShownWindow {
	id: string;
	kind: DesktopWindowKind;
	title: string;
}

/** What the desktop server sends about the desktop's windows. */
interface WindowsMessage {
	type: "windows";
	windows: DisplayWindow[];
}

/** Who is driving the desktop: the agent, at work in its browser, or a person who took over. */
export type Driver = "agent" | "person";

/** The agent whose desktop it is, as much of it as the desktop shows. */
type DesktopAgent = Pick<Agent, "id" | "name" | "color" | "face" | "shape">;

/** How far each window opens below and to the right of the one before, in pixels. */
const CASCADE_STEP = 28;
/** The agent's face in the wallpaper, in pixels, and how faintly it shows. */
const WALLPAPER_FACE_SIZE = 620;
const WALLPAPER_FACE_OPACITY = 0.16;

/**
 * The agent's desktop, drawn here rather than in the sandbox: a wallpaper
 * with the agent's face in it, so it's plain whose desktop it is, a dock,
 * and a window for each of its apps, each app on a display of its own and
 * shown over VNC, sized to its window; its terminal and file browser are
 * drawn here. The dock's dots take the colour of whoever is driving: the
 * agent's own, or neutral for a person. Unless
 * `viewOnly`, the person's mouse and keys go to the windows' apps, and they
 * can close the windows of apps the agent started. It lets go of every
 * connection after the idle time a single screen does.
 */
export function AgentDesktop({
	threadId,
	agent,
	viewOnly,
	driver,
}: {
	threadId: string;
	agent: DesktopAgent;
	viewOnly: boolean;
	driver: Driver | undefined;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [attempt, setAttempt] = useState(0);
	const idle = useViewerIdle(root, threadId, agent.id, attempt);
	return (
		<div
			ref={root}
			className="relative min-h-0 w-full flex-1 overflow-hidden rounded-panel border border-border bg-rail"
		>
			<div
				aria-hidden
				className="pointer-events-none absolute"
				style={{
					right: -WALLPAPER_FACE_SIZE / 4,
					bottom: -WALLPAPER_FACE_SIZE / 3,
					opacity: WALLPAPER_FACE_OPACITY,
				}}
			>
				<AgentAvatar
					color={agent.color}
					face={agent.face}
					shape={agent.shape}
					size={WALLPAPER_FACE_SIZE}
				/>
			</div>
			{idle ? (
				<StandingOverlay
					standing="idle"
					what="desktop"
					onReconnect={() => setAttempt((count) => count + 1)}
				/>
			) : (
				<DesktopSurface
					key={attempt}
					threadId={threadId}
					agentId={agent.id}
					viewOnly={viewOnly}
					driverColor={
						driver === "agent"
							? botColors[agent.color].face
							: driver === "person"
								? "var(--foreground)"
								: undefined
					}
				/>
			)}
		</div>
	);
}

/** The desktop's windows and dock, connected to the desktop server while mounted. */
function DesktopSurface({
	threadId,
	agentId,
	viewOnly,
	driverColor,
}: {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
	driverColor: string | undefined;
}) {
	const surface = useRef<HTMLDivElement>(null);
	const socket = useRef<WebSocket | undefined>(undefined);
	const [displayWindows, setDisplayWindows] = useState<DisplayWindow[] | undefined>(undefined);
	const [serverLost, setServerLost] = useState(false);
	const [localOpen, setLocalOpen] = useState<ReadonlySet<LocalWindowKind>>(new Set());
	const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map());
	// Each app is on a display of its own, with a clipboard of its own, so what
	// one copies is put on the others, and on the person's own.
	const [clipboard, setClipboard] = useState<string | undefined>(undefined);
	const copied = (text: string) => {
		setClipboard(text);
		void navigator.clipboard.writeText(text).catch(() => {});
	};

	// The desktop's apps take on the person's light or dark look, as the app does.
	const scheme = useResolvedTheme();
	const schemeNow = useRef(scheme);
	useEffect(() => {
		schemeNow.current = scheme;
		if (socket.current?.readyState === WebSocket.OPEN) {
			socket.current.send(themeMessage(scheme));
		}
	}, [scheme]);

	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "windows"));
		socket.current = opened;
		opened.onopen = () => opened.send(themeMessage(schemeNow.current));
		opened.onmessage = (event) =>
			setDisplayWindows((JSON.parse(String(event.data)) as WindowsMessage).windows);
		opened.onclose = () => {
			if (socket.current === opened) setServerLost(true);
		};
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId]);

	/** Sizes a window's display to the window, whoever is viewing: the desktop server does it, not VNC. */
	const resizeDisplay = (id: string) => (width: number, height: number) => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify({ type: "resize", id, width, height }));
	};
	const closeDisplay = (id: string) => {
		if (viewOnly || socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify({ type: "close", id }));
	};

	const windows: ShownWindow[] = [
		...(displayWindows ?? []),
		...[...localOpen].map((kind) => ({ id: kind, kind, title: "" })),
	];

	// A window opening for the first time is placed by kind, in front of the rest.
	useEffect(() => {
		const element = surface.current;
		const unplaced = windows.filter((window) => !placements.has(window.id));
		if (!element || unplaced.length === 0) return;
		setPlacements((current) => {
			const next = new Map(current);
			for (const window of unplaced) {
				next.set(
					window.id,
					initialPlacement(window.kind, next.size, frontOrder(next) + 1, element),
				);
			}
			return next;
		});
	});

	const place = (id: string, change: Partial<Placement>) =>
		setPlacements((current) => {
			const placement = current.get(id);
			if (!placement) return current;
			return new Map(current).set(id, { ...placement, ...change });
		});
	const focus = (id: string) =>
		setPlacements((current) => {
			const placement = current.get(id);
			const front = frontOrder(current);
			if (!placement || (placement.order === front && !placement.minimized)) return current;
			return new Map(current).set(id, { ...placement, order: front + 1, minimized: false });
		});

	const shown = windows.filter((window) => {
		const placement = placements.get(window.id);
		return placement && !placement.minimized;
	});
	const frontId = shown.reduce<string | undefined>((front, window) => {
		const order = placements.get(window.id)?.order ?? 0;
		return front === undefined || order > (placements.get(front)?.order ?? 0) ? window.id : front;
	}, undefined);

	/** What a dock item does: opens its window, brings it forward, or tucks it away if it's already in front. */
	const toggle = (id: string, open: () => void) => {
		const placement = placements.get(id);
		if (!windows.some((window) => window.id === id) || !placement) return open();
		if (!placement.minimized && id === frontId) return place(id, { minimized: true });
		focus(id);
	};
	const openLocal = (kind: LocalWindowKind) => () =>
		setLocalOpen((current) => new Set([...current, kind]));
	const closeLocal = (kind: LocalWindowKind) =>
		setLocalOpen((current) => new Set([...current].filter((open) => open !== kind)));

	const isOpen = (kind: DesktopWindowKind) => windows.some((window) => window.kind === kind);
	const appWindows = windows.filter((window) => window.kind === "app");

	return (
		<div ref={surface} className="absolute inset-0">
			{shown.map((window) => {
				const placement = placements.get(window.id);
				if (!placement) return null;
				const frame: WindowFrame = {
					placement,
					front: window.id === frontId,
					surface,
					onFocus: () => focus(window.id),
					onPlace: (change) => place(window.id, change),
					onMinimize: () => place(window.id, { minimized: true }),
				};
				if (window.kind === "files") {
					return (
						<FilesWindow
							key={window.id}
							{...frame}
							threadId={threadId}
							agentId={agentId}
							viewOnly={viewOnly}
							onClose={() => closeLocal("files")}
						/>
					);
				}
				if (window.kind === "terminal") {
					return (
						<DesktopWindow
							key={window.id}
							{...frame}
							label={windowTitle(window)}
							strip={{ title: <WindowTitle>{windowTitle(window)}</WindowTitle> }}
							onClose={() => closeLocal("terminal")}
						>
							<TerminalView threadId={threadId} agentId={agentId} viewOnly={viewOnly} />
						</DesktopWindow>
					);
				}
				const isBrowser = window.kind === "browser";
				return (
					<DesktopWindow
						key={window.id}
						{...frame}
						label={isBrowser ? "Browser" : windowTitle(window)}
						strip={{ title: <WindowTitle>{windowTitle(window)}</WindowTitle> }}
						// The browser is the agent's, at work in it, so closing it only hides it.
						onClose={
							isBrowser ? frame.onMinimize : viewOnly ? undefined : () => closeDisplay(window.id)
						}
					>
						<WindowDisplay
							url={windowUrl(threadId, agentId, window.id)}
							viewOnly={viewOnly}
							what={isBrowser ? "browser" : "window"}
							onResize={resizeDisplay(window.id)}
							clipboard={clipboard}
							onClipboard={copied}
						/>
					</DesktopWindow>
				);
			})}
			{(serverLost || displayWindows === undefined) && (
				<StandingOverlay
					standing={serverLost ? "ended" : "connecting"}
					what="desktop"
					onReconnect={() => {}}
				/>
			)}
			<nav
				aria-label="Dock"
				className="absolute bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-1 rounded-[18px] border border-white/15 bg-white/10 px-2 pt-1.5 pb-2 shadow-lg backdrop-blur-md"
			>
				<DockItem
					label="Browser"
					kind="browser"
					open={isOpen("browser")}
					dotColor={driverColor}
					onClick={() => toggle("browser", () => {})}
				/>
				<DockItem
					label="Terminal"
					kind="terminal"
					open={isOpen("terminal")}
					dotColor={driverColor}
					onClick={() => toggle("terminal", openLocal("terminal"))}
				/>
				<DockItem
					label="Files"
					kind="files"
					open={isOpen("files")}
					dotColor={driverColor}
					onClick={() => toggle("files", openLocal("files"))}
				/>
				{appWindows.map((window) => (
					<DockItem
						key={window.id}
						label={windowTitle(window)}
						kind="app"
						open
						dotColor={driverColor}
						onClick={() => toggle(window.id, () => {})}
					/>
				))}
			</nav>
		</div>
	);
}

/** What tells the desktop server which look the person is viewing the desktop in. */
function themeMessage(scheme: "light" | "dark") {
	return JSON.stringify({ type: "theme", scheme });
}

/**
 * A window's display, saying so while it connects or if it can't be reached,
 * and saying how big it's shown, in pixels, as that changes, so the display
 * can be sized to match. It shares the desktop's clipboard, as `VncView` does.
 */
function WindowDisplay({
	url,
	viewOnly,
	what,
	onResize,
	clipboard,
	onClipboard,
}: {
	url: string;
	viewOnly: boolean;
	what: "browser" | "window";
	onResize: (width: number, height: number) => void;
	clipboard: string | undefined;
	onClipboard: (text: string) => void;
}) {
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	const room = useRef<HTMLDivElement>(null);
	const onResizeNow = useRef(onResize);
	onResizeNow.current = onResize;
	useEffect(() => {
		const element = room.current;
		if (!element) return;
		const sized = new ResizeObserver(() =>
			onResizeNow.current(Math.round(element.clientWidth), Math.round(element.clientHeight)),
		);
		sized.observe(element);
		return () => sized.disconnect();
	}, []);
	return (
		<div ref={room} className="absolute inset-0">
			<VncView
				key={attempt}
				url={url}
				viewOnly={viewOnly}
				onStanding={setStanding}
				clipboard={clipboard}
				onClipboard={onClipboard}
			/>
			<StandingOverlay
				standing={standing}
				what={what}
				onReconnect={() => setAttempt((count) => count + 1)}
			/>
		</div>
	);
}

/**
 * A dock item: an app to open, or a window open on the desktop, by its
 * icon, with a dot in the driver's colour while open.
 */
function DockItem({
	label,
	kind,
	open,
	dotColor,
	onClick,
}: {
	label: string;
	kind: DesktopWindowKind;
	open: boolean;
	dotColor: string | undefined;
	onClick: () => void;
}) {
	return (
		<Tooltip label={label} side="top">
			<button
				type="button"
				aria-label={label}
				aria-pressed={open}
				onClick={onClick}
				className="focus-ring group relative grid size-12 place-items-center rounded-[12px]"
			>
				<span className="drop-shadow-sm transition-transform group-hover:-translate-y-0.5">
					<AppIconFor kind={kind} />
				</span>
				{open && (
					<span
						aria-hidden
						className="absolute -bottom-0.5 size-1 rounded-full bg-muted-foreground"
						style={dotColor ? { backgroundColor: dotColor } : undefined}
					/>
				)}
			</button>
		</Tooltip>
	);
}

const DOCK_ICON_SIZE = 40;

function AppIconFor({ kind }: { kind: DesktopWindowKind }): ReactNode {
	if (kind === "browser") return <BrowserIcon size={DOCK_ICON_SIZE} />;
	if (kind === "terminal") return <TerminalIcon size={DOCK_ICON_SIZE} />;
	if (kind === "files") return <FilesIcon size={DOCK_ICON_SIZE} />;
	return <AppIcon size={DOCK_ICON_SIZE} />;
}

function windowTitle(window: ShownWindow) {
	if (window.kind === "terminal") return "Terminal";
	if (window.kind === "browser") return window.title || "Browser";
	if (window.kind === "files") return "Files";
	return window.title || `Display ${window.id}`;
}

function frontOrder(placements: ReadonlyMap<string, Placement>) {
	return Math.max(0, ...[...placements.values()].map((placement) => placement.order));
}

/** Where a window of `kind` first opens, the `index`th to open, on a desktop the size of `surface`. */
function initialPlacement(
	kind: DesktopWindowKind,
	index: number,
	order: number,
	surface: HTMLElement,
): Placement {
	const { clientWidth: width, clientHeight: height } = surface;
	const share = {
		browser: { x: 0.04, y: 0.05, width: 0.66, height: 0.74 },
		// Wide enough for its places beside the folder.
		files: { x: 0.3, y: 0.18, width: 0.6, height: 0.64 },
	}[kind as string] ?? { x: 0.36, y: 0.24, width: 0.5, height: 0.56 };
	const offset = kind === "browser" ? 0 : index * CASCADE_STEP;
	return {
		x: Math.round(width * share.x) + offset,
		y: Math.round(height * share.y) + offset,
		width: Math.max(MIN_WINDOW_WIDTH, Math.round(width * share.width)),
		height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height * share.height)),
		order,
		minimized: false,
		maximized: false,
	};
}
