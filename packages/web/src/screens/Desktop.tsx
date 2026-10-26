import { cn } from "cn";
import { AppWindow, Folder, Globe, Minus, SquareTerminal, X } from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useViewerIdle } from "@/lib/desktop.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { BrowserBar } from "./BrowserBar.tsx";
import wallpaper from "./desktop-wallpaper.svg";
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
	/** `browser`, `files`, or the number of a display the agent started. */
	id: string;
	kind: "browser" | "files" | "app";
	/** The title of the window in front on its display, if it has one. */
	title: string;
}

/** Every window the desktop can show: those on displays, and its terminal. */
type DesktopWindowKind = DisplayWindow["kind"] | "terminal";

interface ShownWindow {
	id: string;
	kind: DesktopWindowKind;
	title: string;
}

/** Where a window is on the desktop, in pixels from its top left, and whether it's tucked into the dock. */
interface Placement {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Higher is in front. */
	order: number;
	minimized: boolean;
}

/** What the desktop server sends about the desktop's windows. */
interface WindowsMessage {
	type: "windows";
	windows: DisplayWindow[];
}

const TERMINAL_ID = "terminal";
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 200;
/** How far each window opens below and to the right of the one before, in pixels. */
const CASCADE_STEP = 28;

/**
 * The agent's desktop, drawn here rather than in the sandbox: a wallpaper,
 * a dock, and a window for each of its apps, each app on a display of its
 * own and shown over VNC, sized to its window; its terminal is a terminal
 * here. Unless `viewOnly`, the person's mouse and keys go to the windows'
 * apps, and they can open the terminal and file manager and close them. It
 * lets go of every connection after the idle time a single screen does.
 */
export function AgentDesktop({
	threadId,
	agentId,
	viewOnly,
}: {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [attempt, setAttempt] = useState(0);
	const idle = useViewerIdle(root, threadId, agentId, attempt);
	return (
		<div
			ref={root}
			className="relative min-h-0 w-full flex-1 overflow-hidden rounded-panel bg-center bg-cover bg-list"
			style={{ backgroundImage: `url(${wallpaper})` }}
		>
			{idle ? (
				<StandingOverlay
					standing="idle"
					what="desktop"
					onReconnect={() => setAttempt((count) => count + 1)}
				/>
			) : (
				<DesktopSurface key={attempt} threadId={threadId} agentId={agentId} viewOnly={viewOnly} />
			)}
		</div>
	);
}

/** The desktop's windows and dock, connected to the desktop server while mounted. */
function DesktopSurface({
	threadId,
	agentId,
	viewOnly,
}: {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
}) {
	const surface = useRef<HTMLDivElement>(null);
	const socket = useRef<WebSocket | undefined>(undefined);
	const [displayWindows, setDisplayWindows] = useState<DisplayWindow[] | undefined>(undefined);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map());

	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "windows"));
		socket.current = opened;
		opened.onmessage = (event) =>
			setDisplayWindows((JSON.parse(String(event.data)) as WindowsMessage).windows);
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId]);

	const send = (message: { type: "open"; app: "files" } | { type: "close"; id: string }) => {
		if (viewOnly || socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify(message));
	};

	const windows: ShownWindow[] = [
		...(displayWindows ?? []),
		...(terminalOpen ? [{ id: TERMINAL_ID, kind: "terminal" as const, title: "" }] : []),
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

	/** What a dock item does: opens its window, brings it forward, or tucks it away if it's already in front. */
	const toggle = (id: string, open: () => void) => {
		const placement = placements.get(id);
		const shown = windows.some((window) => window.id === id);
		if (!shown || !placement) return open();
		if (!placement.minimized && placement.order === frontOrder(placements)) {
			return place(id, { minimized: true });
		}
		focus(id);
	};
	const close = (window: ShownWindow) => {
		if (window.kind === "terminal") setTerminalOpen(false);
		else send({ type: "close", id: window.id });
	};

	const filesOpen = windows.some((window) => window.kind === "files");
	const appWindows = windows.filter((window) => window.kind === "app");

	return (
		<div ref={surface} className="absolute inset-0">
			{windows.map((window) => {
				const placement = placements.get(window.id);
				if (!placement || placement.minimized) return null;
				return (
					<DesktopWindow
						key={window.id}
						title={windowTitle(window)}
						icon={<WindowIcon kind={window.kind} />}
						placement={placement}
						surface={surface}
						onFocus={() => focus(window.id)}
						onPlace={(change) => place(window.id, change)}
						onMinimize={() => place(window.id, { minimized: true })}
						onClose={window.kind === "browser" || viewOnly ? undefined : () => close(window)}
					>
						<WindowContent
							window={window}
							threadId={threadId}
							agentId={agentId}
							viewOnly={viewOnly}
						/>
					</DesktopWindow>
				);
			})}
			{displayWindows === undefined && (
				<StandingOverlay standing="connecting" what="desktop" onReconnect={() => {}} />
			)}
			<nav
				aria-label="Dock"
				className="absolute bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-1 rounded-[14px] border border-border bg-panel/90 p-1.5 shadow-lg backdrop-blur"
			>
				<DockItem
					label="Browser"
					open={windows.some((window) => window.kind === "browser")}
					onClick={() => toggle("browser", () => {})}
				>
					<Globe />
				</DockItem>
				<DockItem
					label="Terminal"
					open={terminalOpen}
					onClick={() => toggle(TERMINAL_ID, () => setTerminalOpen(true))}
				>
					<SquareTerminal />
				</DockItem>
				<DockItem
					label="Files"
					open={filesOpen}
					disabled={viewOnly && !filesOpen}
					onClick={() => toggle("files", () => send({ type: "open", app: "files" }))}
				>
					<Folder />
				</DockItem>
				{appWindows.map((window) => (
					<DockItem
						key={window.id}
						label={windowTitle(window)}
						open
						onClick={() => toggle(window.id, () => {})}
					>
						<AppWindow />
					</DockItem>
				))}
			</nav>
		</div>
	);
}

/** What a window shows: its app's display over VNC, with the browser's bar over the browser, or the terminal. */
function WindowContent({
	window,
	threadId,
	agentId,
	viewOnly,
}: {
	window: ShownWindow;
	threadId: string;
	agentId: string;
	viewOnly: boolean;
}) {
	if (window.kind === "terminal") {
		return <TerminalView threadId={threadId} agentId={agentId} viewOnly={viewOnly} />;
	}
	const display = (
		<WindowDisplay
			url={windowUrl(threadId, agentId, window.id)}
			viewOnly={viewOnly}
			what={window.kind === "browser" ? "browser" : "window"}
		/>
	);
	if (window.kind !== "browser") return display;
	return (
		<div className="absolute inset-0 flex flex-col">
			<BrowserBar threadId={threadId} agentId={agentId} viewOnly={viewOnly} />
			<div className="relative min-h-0 flex-1">{display}</div>
		</div>
	);
}

/** A window's display, saying so while it connects or if it can't be reached. */
function WindowDisplay({
	url,
	viewOnly,
	what,
}: {
	url: string;
	viewOnly: boolean;
	what: "browser" | "window";
}) {
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	return (
		<>
			<VncView key={attempt} url={url} viewOnly={viewOnly} onStanding={setStanding} />
			<StandingOverlay
				standing={standing}
				what={what}
				onReconnect={() => setAttempt((count) => count + 1)}
			/>
		</>
	);
}

/**
 * A window on the desktop: a title bar to drag it by, with buttons to tuck it
 * into the dock and, given `onClose`, close it, and a corner to resize it by.
 * Clicking anywhere in it brings it to the front.
 */
function DesktopWindow({
	title,
	icon,
	placement,
	surface,
	onFocus,
	onPlace,
	onMinimize,
	onClose,
	children,
}: {
	title: string;
	icon: ReactNode;
	placement: Placement;
	surface: React.RefObject<HTMLDivElement | null>;
	onFocus: () => void;
	onPlace: (change: Partial<Placement>) => void;
	onMinimize: () => void;
	onClose?: () => void;
	children: ReactNode;
}) {
	/** Follows the pointer from where it went down until it comes up, with `change` saying how the window moves. */
	const track =
		(change: (dx: number, dy: number, from: Placement) => Partial<Placement>) =>
		(event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const handle = event.currentTarget;
			handle.setPointerCapture(event.pointerId);
			const from = placement;
			const start = { x: event.clientX, y: event.clientY };
			const bounds = surface.current?.getBoundingClientRect();
			const move = (moved: PointerEvent) => {
				const next = change(moved.clientX - start.x, moved.clientY - start.y, from);
				onPlace(bounds ? keptInside(next, from, bounds) : next);
			};
			const up = () => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
		};

	return (
		<section
			aria-label={title}
			onPointerDownCapture={onFocus}
			className="absolute flex flex-col overflow-hidden rounded-[10px] border border-border-strong bg-panel shadow-2xl"
			style={{
				left: placement.x,
				top: placement.y,
				width: placement.width,
				height: placement.height,
				zIndex: placement.order,
			}}
		>
			<header
				onPointerDown={track((dx, dy, from) => ({ x: from.x + dx, y: from.y + dy }))}
				className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-border border-b pr-1.5 pl-3 active:cursor-grabbing"
			>
				<span aria-hidden className="text-muted-foreground [&_svg]:size-3.5">
					{icon}
				</span>
				<h3 className="m-0 min-w-0 flex-1 truncate font-medium text-[13px] text-soft-foreground">
					{title}
				</h3>
				<IconButton label="Minimize" onPointerDown={stopPropagation} onClick={onMinimize}>
					<Minus />
				</IconButton>
				{onClose && (
					<IconButton label="Close" onPointerDown={stopPropagation} onClick={onClose}>
						<X />
					</IconButton>
				)}
			</header>
			<div className="relative min-h-0 flex-1">{children}</div>
			<div
				aria-hidden
				onPointerDown={track((dx, dy, from) => ({
					width: Math.max(MIN_WINDOW_WIDTH, from.width + dx),
					height: Math.max(MIN_WINDOW_HEIGHT, from.height + dy),
				}))}
				className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
			/>
		</section>
	);
}

/** A dock item: an app to open, or a window open on the desktop, marked when open. */
function DockItem({
	label,
	open,
	disabled,
	onClick,
	children,
}: {
	label: string;
	open: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip label={label} side="top">
			<button
				type="button"
				aria-label={label}
				aria-pressed={open}
				disabled={disabled}
				onClick={onClick}
				className={cn(
					"focus-ring relative grid size-10 place-items-center rounded-[10px] text-soft-foreground transition-colors hover:bg-hover disabled:opacity-50 [&_svg]:size-5",
					open &&
						"after:absolute after:bottom-0.5 after:size-1 after:rounded-full after:bg-foreground",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}

function WindowIcon({ kind }: { kind: DesktopWindowKind }) {
	if (kind === "browser") return <Globe />;
	if (kind === "terminal") return <SquareTerminal />;
	if (kind === "files") return <Folder />;
	return <AppWindow />;
}

function windowTitle(window: ShownWindow) {
	if (window.kind === "terminal") return "Terminal";
	if (window.kind === "browser") return "Browser";
	if (window.kind === "files") return window.title ? `Files: ${window.title}` : "Files";
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
	const share =
		kind === "browser"
			? { x: 0.03, y: 0.03, width: 0.72, height: 0.8 }
			: { x: 0.25, y: 0.1, width: 0.55, height: 0.6 };
	const offset = kind === "browser" ? 0 : index * CASCADE_STEP;
	return {
		x: Math.round(width * share.x) + offset,
		y: Math.round(height * share.y) + offset,
		width: Math.max(MIN_WINDOW_WIDTH, Math.round(width * share.width)),
		height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height * share.height)),
		order,
		minimized: false,
	};
}

/** `next`, moved so the window's title bar stays on the desktop. */
function keptInside(
	next: Partial<Placement>,
	from: Placement,
	bounds: DOMRect,
): Partial<Placement> {
	const width = next.width ?? from.width;
	const x = next.x ?? from.x;
	const y = next.y ?? from.y;
	const visible = Math.min(width, 80);
	return {
		...next,
		...(next.x === undefined
			? {}
			: { x: Math.min(Math.max(x, visible - width), bounds.width - visible) }),
		...(next.y === undefined ? {} : { y: Math.min(Math.max(y, 0), bounds.height - 36) }),
	};
}

function stopPropagation(event: ReactPointerEvent) {
	event.stopPropagation();
}
