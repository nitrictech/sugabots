import { botColors } from "@sugabots/avatars";
import type { Agent } from "@sugabots/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useViewerIdle } from "@/lib/desktop.ts";
import { useResolvedTheme } from "@/lib/theme.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { type ScreenBounds, ScreenRegion, SharedScreen } from "./DesktopScreen.tsx";
import {
	DesktopWindow,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
	type Placement,
	TITLE_STRIP_HEIGHT,
	WINDOW_BORDER,
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
	type VncScreen,
	windowUrl,
} from "./VncView.tsx";

/**
 * One of the windows on the desktop's display in the sandbox, as its server
 * lists them, where it is on the display: a browser's or another app's,
 * framed here, or a popup, such as a menu, shown as it is.
 */
export interface DisplayWindow extends ScreenBounds {
	/** The window's X id. */
	id: string;
	kind: "browser" | "app" | "popup";
	title: string;
	minimized: boolean;
	/** The window a dialog or popup belongs to. */
	parent?: string;
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

/**
 * What the desktop server sends about the desktop's windows, and the name of
 * its pointer, or "" for one an app drew itself.
 */
type DesktopServerMessage =
	| { type: "windows"; windows: DisplayWindow[] }
	| { type: "cursor"; name: string };

/** Who is driving the desktop: the agent, at work in its browser, or a person who took over. */
export type Driver = "agent" | "person";

/** The agent whose desktop it is, as much of it as the desktop shows. */
type DesktopAgent = Pick<Agent, "id" | "name" | "color" | "face" | "shape">;

/** How far each window opens below and to the right of the one before, in pixels, from how far into the desktop the first opens. */
const CASCADE_STEP = 28;
const CASCADE_START = 0.04;
/** How long after a person last resized a window its frame keeps to the size they gave it, over the size the display says it is. */
const SETTLE_MS = 600;
/** The agent's face in the wallpaper, in pixels, and how faintly it shows. */
const WALLPAPER_FACE_SIZE = 620;
const WALLPAPER_FACE_OPACITY = 0.16;

/**
 * The agent's desktop, drawn here rather than in the sandbox: a wallpaper
 * with the agent's face in it, so it's plain whose desktop it is, a dock,
 * and a window for each of its apps' windows, each showing that window
 * from the desktop's display, over VNC; its terminal and file browser are
 * drawn here. Every app is on the one display, so apps drag and drop
 * between each other as on any desktop. The dock's dots take the colour of whoever is driving: the
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

/** The desktop's windows and dock, connected to the desktop server and its display while mounted. */
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
	const [screen, setScreen] = useState<VncScreen | undefined>(undefined);
	const [screenStanding, setScreenStanding] = useState<Standing>("connecting");
	const [cursorName, setCursorName] = useState("");
	const [localOpen, setLocalOpen] = useState<ReadonlySet<LocalWindowKind>>(new Set());
	const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map());
	/**
	 * When a person last resized each window, or forever while they're still
	 * resizing it. The size the display says it is lags behind, so it's taken
	 * only once the window has settled.
	 */
	const resizedAt = useRef(new Map<string, number>());
	/** The placements, with what a person has done since they were last drawn. */
	const latestPlacements = useRef(placements);
	latestPlacements.current = placements;

	// The desktop's apps take on the person's light or dark look, as the app does.
	const scheme = useResolvedTheme();
	const schemeNow = useRef(scheme);
	useEffect(() => {
		schemeNow.current = scheme;
		if (socket.current?.readyState === WebSocket.OPEN) {
			socket.current.send(themeMessage(scheme));
		}
	}, [scheme]);

	const send = (message: object) => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify(message));
	};
	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "windows"));
		socket.current = opened;
		opened.onopen = () => opened.send(themeMessage(schemeNow.current));
		opened.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as DesktopServerMessage;
			if (message.type === "windows") setDisplayWindows(message.windows);
			else setCursorName(message.name);
		};
		opened.onclose = () => {
			if (socket.current === opened) setServerLost(true);
		};
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId]);

	const framed = (displayWindows ?? []).filter((window) => window.kind !== "popup");
	const popups = (displayWindows ?? []).filter((window) => window.kind === "popup");
	const windows: ShownWindow[] = [
		...framed,
		...[...localOpen].map((kind) => ({ id: kind, kind, title: "" })),
	];
	const onDisplay = (id: string) => framed.find((window) => window.id === id);

	// A window opening for the first time is placed by kind, a dialog over the
	// window it belongs to, in front of the rest. A window's frame is the size
	// the display has it, unless a person is resizing it.
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		setPlacements((current) => {
			let next: Map<string, Placement> | undefined;
			const change = (id: string, placement: Placement) => {
				next ??= new Map(current);
				next.set(id, placement);
			};
			for (const window of displayWindows ?? []) {
				if (window.kind === "popup") continue;
				const placed = current.get(window.id);
				const settled = Date.now() - (resizedAt.current.get(window.id) ?? 0) > SETTLE_MS;
				const size = frameSize(window);
				if (!placed) {
					const placements = next ?? current;
					const parent = window.parent ? placements.get(window.parent) : undefined;
					change(window.id, {
						...size,
						...(parent ? centredOver(parent, size) : cascaded(placements.size, element)),
						order: frontOrder(placements) + 1,
						minimized: window.minimized,
						maximized: false,
					});
				} else if (
					settled &&
					!placed.maximized &&
					(placed.width !== size.width ||
						placed.height !== size.height ||
						placed.minimized !== window.minimized)
				) {
					change(window.id, { ...placed, ...size, minimized: window.minimized });
				}
			}
			for (const kind of localOpen) {
				if (current.has(kind)) continue;
				const placements = next ?? current;
				change(kind, initialPlacement(kind, placements.size, frontOrder(placements) + 1, element));
			}
			return next ?? current;
		});
	}, [displayWindows, localOpen]);

	/** Sizes a window on the display to fit its frame, if it doesn't. */
	const sendSize = (id: string) => {
		const placement = latestPlacements.current.get(id);
		const window = onDisplay(id);
		const element = surface.current;
		if (!placement || !window || !element || viewOnly) return;
		resizedAt.current.set(id, Date.now());
		const { width, height } = contentSize(placement, element);
		if (width === window.width && height === window.height) return;
		send({ type: "size", id, width, height });
	};
	/**
	 * Moves or resizes a window's frame. Its window on the display is shown
	 * wherever its frame is, so moving it is the frame's alone. Resized, the
	 * window takes the frame's size once the person lets go, or straight away
	 * when it fills the desktop or stops filling it: resizing it at every step
	 * makes the app draw it again at every step.
	 */
	const place = (id: string, change: Partial<Placement>) => {
		const placement = latestPlacements.current.get(id);
		if (!placement) return;
		const next = { ...placement, ...change };
		latestPlacements.current = new Map(latestPlacements.current).set(id, next);
		setPlacements((current) => new Map(current).set(id, { ...current.get(id), ...next }));
		if (change.maximized !== undefined) return sendSize(id);
		if (change.width !== undefined || change.height !== undefined) {
			resizedAt.current.set(id, Number.POSITIVE_INFINITY);
		}
	};
	const focus = (id: string) => {
		const placement = placements.get(id);
		if (!placement) return;
		const front = frontOrder(placements);
		if (placement.order === front && !placement.minimized) return;
		// Clicking a window on the display focuses it there too; this is for the
		// dock, and for the keys. Sent with each click, it costs apps their double-clicks.
		if (!viewOnly && onDisplay(id)) send({ type: "focus", id });
		setPlacements((current) =>
			new Map(current).set(id, { ...placement, order: front + 1, minimized: false }),
		);
	};
	const minimize = (id: string) => {
		place(id, { minimized: true });
		if (!viewOnly && onDisplay(id)) send({ type: "minimize", id });
	};

	const shown = windows.filter((window) => {
		const placement = placements.get(window.id);
		return placement && !placement.minimized;
	});
	const frontId = shown.reduce<string | undefined>((front, window) => {
		const order = placements.get(window.id)?.order ?? 0;
		return front === undefined || order > (placements.get(front)?.order ?? 0) ? window.id : front;
	}, undefined);

	/** What a dock item does: opens its window, brings it forward, or tucks it away if it's already in front. */
	const toggle = (id: string | undefined, open: () => void) => {
		const placement = id === undefined ? undefined : placements.get(id);
		if (id === undefined || !windows.some((window) => window.id === id) || !placement) {
			return open();
		}
		if (!placement.minimized && id === frontId) return minimize(id);
		focus(id);
	};
	const openLocal = (kind: LocalWindowKind) => () =>
		setLocalOpen((current) => new Set([...current, kind]));
	const closeLocal = (kind: LocalWindowKind) =>
		setLocalOpen((current) => new Set([...current].filter((open) => open !== kind)));

	const isOpen = (kind: DesktopWindowKind) => windows.some((window) => window.kind === kind);
	const frontmost = (candidates: ShownWindow[]) =>
		candidates.reduce<ShownWindow | undefined>(
			(front, window) =>
				!front || (placements.get(window.id)?.order ?? 0) > (placements.get(front.id)?.order ?? 0)
					? window
					: front,
			undefined,
		);
	const browser = frontmost(framed.filter((window) => window.kind === "browser"));
	// Dialogs are in the dock with the window they belong to.
	const appWindows = framed.filter((window) => window.kind === "app" && !window.parent);
	const popupOrder = frontOrder(placements) + 1;

	return (
		<div ref={surface} className="absolute inset-0">
			<SharedScreen
				url={windowUrl(threadId, agentId, "browser")}
				viewOnly={viewOnly}
				onStanding={setScreenStanding}
				onScreen={setScreen}
				onClipboard={(text) => void navigator.clipboard.writeText(text).catch(() => {})}
			/>
			{shown.map((window) => {
				const placement = placements.get(window.id);
				if (!placement) return null;
				const frame: WindowFrame = {
					placement,
					front: window.id === frontId,
					surface,
					onFocus: () => focus(window.id),
					onPlace: (change) => place(window.id, change),
					onSettle: () => sendSize(window.id),
					onMinimize: () => minimize(window.id),
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
				const bounds = onDisplay(window.id);
				return (
					<DesktopWindow
						key={window.id}
						{...frame}
						label={isBrowser ? "Browser" : windowTitle(window)}
						strip={{ title: <WindowTitle>{windowTitle(window)}</WindowTitle> }}
						// The browser is the agent's, at work in it, so closing it only hides it.
						onClose={
							isBrowser
								? frame.onMinimize
								: viewOnly
									? undefined
									: () => send({ type: "close", id: window.id })
						}
					>
						{bounds && (
							<ScreenRegion
								screen={screen}
								bounds={bounds}
								viewOnly={viewOnly}
								cursorName={cursorName}
							/>
						)}
					</DesktopWindow>
				);
			})}
			{popups.map((popup) => {
				// A popup opens where it does beside its window on the display, so it's shown there beside its frame.
				const parent = popup.parent ? onDisplay(popup.parent) : undefined;
				const placement = parent ? placements.get(parent.id) : undefined;
				if (!parent || !placement || placement.minimized) return null;
				const origin = contentOrigin(placement);
				return (
					<div
						key={popup.id}
						className="absolute"
						style={{
							left: origin.x + popup.x - parent.x,
							top: origin.y + popup.y - parent.y,
							width: popup.width,
							height: popup.height,
							zIndex: popupOrder,
						}}
					>
						<ScreenRegion
							screen={screen}
							bounds={popup}
							viewOnly={viewOnly}
							cursorName={cursorName}
						/>
					</div>
				);
			})}
			{(serverLost || displayWindows === undefined || screenStanding !== "connected") && (
				<StandingOverlay
					standing={serverLost ? "ended" : screenStanding === "ended" ? "ended" : "connecting"}
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
					onClick={() => toggle(browser?.id, () => {})}
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

/** Where the frame around a window on the display goes, so the window shows through it where it is. */
/** How big the frame around a window on the display is, to show the window whole. */
function frameSize(window: ScreenBounds) {
	return {
		width: window.width + 2 * WINDOW_BORDER,
		height: window.height + TITLE_STRIP_HEIGHT + 2 * WINDOW_BORDER,
	};
}

/** How big the window inside a frame placed at `placement` is, on a desktop the size of `surface`. */
function contentSize(placement: Placement, surface: HTMLElement) {
	const frame = placement.maximized
		? { width: surface.clientWidth, height: surface.clientHeight }
		: placement;
	return {
		width: frame.width - 2 * WINDOW_BORDER,
		height: frame.height - TITLE_STRIP_HEIGHT - 2 * WINDOW_BORDER,
	};
}

/** Where the window inside a frame placed at `placement` starts on the desktop. */
function contentOrigin(placement: Placement) {
	const frame = placement.maximized ? { x: 0, y: 0 } : placement;
	return {
		x: frame.x + WINDOW_BORDER,
		y: frame.y + TITLE_STRIP_HEIGHT + WINDOW_BORDER,
	};
}

/** Where a frame of `size` goes to sit in the middle of `parent`'s. */
function centredOver(parent: Placement, size: { width: number; height: number }) {
	return {
		x: Math.round(parent.x + (parent.width - size.width) / 2),
		y: Math.round(parent.y + (parent.height - size.height) / 2),
	};
}

/** Where the `index`th window to open goes on a desktop the size of `surface`, each below and right of the one before. */
function cascaded(index: number, surface: HTMLElement) {
	return {
		x: Math.round(surface.clientWidth * CASCADE_START) + index * CASCADE_STEP,
		y: Math.round(surface.clientHeight * CASCADE_START) + index * CASCADE_STEP,
	};
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
	return window.title || "Window";
}

function frontOrder(placements: ReadonlyMap<string, Placement>) {
	return Math.max(0, ...[...placements.values()].map((placement) => placement.order));
}

/** Where a window of `kind` first opens, the `index`th to open, on a desktop the size of `surface`. */
function initialPlacement(
	kind: LocalWindowKind,
	index: number,
	order: number,
	surface: HTMLElement,
): Placement {
	const { clientWidth: width, clientHeight: height } = surface;
	const share = {
		// Wide enough for its places beside the folder.
		files: { x: 0.3, y: 0.18, width: 0.6, height: 0.64 },
		terminal: { x: 0.36, y: 0.24, width: 0.5, height: 0.56 },
	}[kind];
	const offset = index * CASCADE_STEP;
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
