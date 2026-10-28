import type RFB from "@novnc/novnc";
import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Monitor } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { Sheet } from "@/ui/sheet.tsx";

/**
 * An agent's computer opened beside its chat, live: where the browser it
 * drives is shown. Opening it starts the desktop, and the sandbox if it was
 * paused, so the first connection can take a few seconds; it comes over a
 * WebSocket the API relays from the sandbox. The person watches until they
 * take over, if the pod lets them use desktops, and can hand control back.
 * Without a computer, because the workspace has none set up or the bot does
 * not use one, it says so and where to change that.
 */
export function DesktopStage({
	threadId,
	agent,
	pod,
	mayUse,
	onClose,
}: {
	threadId: string;
	agent: Agent;
	pod: Pod;
	/** Whether the person holds the pod's `useDesktops`, and so may take over. */
	mayUse: boolean;
	onClose: () => void;
}) {
	const { missing, failed } = useMissingComputer(agent);
	const may = useWorkspacePermissions();
	const backToChat = useBackToHere("Chat");
	return (
		<Stage
			label={`${agent.name}'s computer`}
			immersive
			icon={
				<StageMark>
					<Monitor strokeWidth={2} />
				</StageMark>
			}
			title={`${agent.name}'s computer`}
			byline={
				missing === undefined ? undefined : (
					<span className="flex items-center gap-1.5">
						<span
							aria-hidden
							className={cn(
								"size-1.5 rounded-full",
								missing === null ? "bg-success" : "bg-disabled-foreground",
							)}
						/>
						{missing === null ? "Live from its computer" : "No computer"}
					</span>
				)
			}
			onClose={onClose}
		>
			{missing === "workspace" ? (
				<EmptyState icon={<Monitor strokeWidth={1.75} />} title="Computers aren't set up yet">
					{may.manageProviders ? (
						<>
							Computers let bots run commands, open websites and edit files. They're set up once for
							the whole workspace.
							<span className="mt-5 flex justify-center">
								<Link
									from="/$workspace"
									to="./settings/$section"
									params={{ section: "sandboxes" }}
									state={backToChat}
									className={buttonStyles({ size: "sm" })}
								>
									Set up computers
								</Link>
							</span>
						</>
					) : (
						"Computers let bots run commands, open websites and edit files. Ask a workspace admin to set them up."
					)}
				</EmptyState>
			) : missing === "bot" ? (
				<EmptyState icon={<Monitor strokeWidth={1.75} />} title={`${agent.name} has no computer`}>
					Give it one in its settings, so it can run commands, open websites and edit files.{" "}
					{pod.permissions.updateAgents && (
						<Link
							{...agentSettingsLink({ pod, agent })}
							state={backToChat}
							className="text-link underline"
						>
							Open {agent.name}'s settings.
						</Link>
					)}
				</EmptyState>
			) : missing === null ? (
				<ComputerScreen threadId={threadId} agent={agent} mayUse={mayUse} />
			) : failed ? (
				<EmptyState title="Could not check for a computer">
					The API did not answer. Reload this page to try again.
				</EmptyState>
			) : null}
		</Stage>
	);
}

/**
 * What stands between the bot and a computer: the workspace has none, or the
 * bot doesn't use one; `null` when nothing does, and `undefined` while that is
 * being checked or, when `failed`, could not be.
 */
function useMissingComputer(agent: Agent): {
	missing: "workspace" | "bot" | null | undefined;
	failed: boolean;
} {
	const access = useSandboxAccess();
	const sandboxes = access.data;
	const missing =
		sandboxes === undefined
			? undefined
			: !sandboxes.enabled
				? "workspace"
				: !agent.usesSandbox
					? "bot"
					: null;
	return { missing, failed: access.isError };
}

/**
 * A phone's first look at the bot's computer, in a sheet: its screen, watch
 * only, which opens it in full to take over; or, without a computer, why not
 * and where to give it one.
 */
export function ComputerSheet({
	threadId,
	agent,
	pod,
	open,
	onOpenChange,
	onOpenFull,
}: {
	threadId: string;
	agent: Agent;
	pod: Pod;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenFull: () => void;
}) {
	const { missing, failed } = useMissingComputer(agent);
	const may = useWorkspacePermissions();
	const backToChat = useBackToHere("Chat");
	return (
		<Sheet open={open} onOpenChange={onOpenChange} title={`${agent.name}'s computer`}>
			{missing === null ? (
				<div className="relative overflow-hidden rounded-[12px] border border-border-strong bg-panel">
					<DesktopScreen threadId={threadId} agentId={agent.id} viewOnly />
					<button
						type="button"
						onClick={onOpenFull}
						aria-label={`Open ${agent.name}'s desktop`}
						className="focus-ring absolute inset-0"
					/>
				</div>
			) : missing === "workspace" ? (
				<NoComputer title="Computers aren't set up yet">
					{may.manageProviders ? (
						<>
							Computers let bots run commands, open websites and edit files. They're set up once for
							the whole workspace.
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "sandboxes" }}
								state={backToChat}
								className={cn(buttonStyles(), SHEET_BUTTON_CLASS_NAME)}
							>
								Set up computers
							</Link>
						</>
					) : (
						"Ask a workspace admin to set up computers."
					)}
				</NoComputer>
			) : missing === "bot" ? (
				<NoComputer title={`${agent.name} doesn't have a computer`}>
					{pod.permissions.updateAgents ? (
						<>
							Give it a computer to run commands, browse and make files.
							<Link
								{...agentSettingsLink({ pod, agent })}
								state={backToChat}
								className={cn(buttonStyles(), SHEET_BUTTON_CLASS_NAME)}
							>
								Open {agent.name}'s settings
							</Link>
						</>
					) : (
						"Ask a workspace admin to give it a computer."
					)}
				</NoComputer>
			) : failed ? (
				<NoComputer title="Could not check for a computer">
					The API did not answer. Reload this page to try again.
				</NoComputer>
			) : null}
		</Sheet>
	);
}

/** A sheet's one way forward: across its width, a thumb high. */
const SHEET_BUTTON_CLASS_NAME = "mt-4 h-[46px] w-full rounded-[12px] text-[15px]";

/** Why the sheet has no computer to show, under a screen, with what can be done about it. */
function NoComputer({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-2.5 px-3 pt-5 pb-1.5 text-center">
			<Monitor aria-hidden size={28} strokeWidth={1.75} className="text-muted-foreground" />
			<span className="font-medium text-[15px] text-foreground">{title}</span>
			<p className="m-0 flex w-full flex-col items-center text-[13px] text-muted-foreground leading-[1.5]">
				{children}
			</p>
		</div>
	);
}

/** The bot's computer, live, as large as the room allows, with who has control and the way to take it. */
function ComputerScreen({
	threadId,
	agent,
	mayUse,
}: {
	threadId: string;
	agent: Agent;
	mayUse: boolean;
}) {
	const [inControl, setInControl] = useState(false);
	const agentUsing = useDesktopInUse(threadId, agent.id);
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center gap-4 max-md:relative max-md:justify-center">
			{/* As large as the room left by the controls allows, keeping the desktop's 4:3 shape. */}
			<div className="@container-[size] flex min-h-0 w-full flex-1 items-center justify-center">
				<div className="w-[min(100cqw,calc(100cqh*4/3))]">
					<DesktopScreen threadId={threadId} agentId={agent.id} viewOnly={!inControl} />
				</div>
			</div>
			<div className="flex max-w-full items-center gap-2.5 rounded-full border border-border-strong bg-panel py-1.5 pr-1.5 pl-3 text-sm max-md:glass max-md:absolute max-md:bottom-6 max-md:max-w-[calc(100%-32px)] max-md:border-0 max-md:py-1.5 max-md:pl-4 max-md:text-[15px]">
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
							<b className="font-semibold text-foreground">You</b> have control. What you do here is
							real.
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
	);
}

/**
 * The agent's screen in the reply that is using it, watch-only, so people see
 * the browser at work without leaving the chat. Clicking it opens the desktop
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
				<DesktopScreen threadId={threadId} agentId={agentId} viewOnly />
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
	const connected = useRef<RFB | undefined>(undefined);
	const viewOnlyNow = useRef(viewOnly);
	const [standing, setStanding] = useState<Standing>("connecting");
	const [attempt, setAttempt] = useState(0);
	const lastUsedAt = useRef(Date.now());
	const agentUsing = useDesktopInUse(threadId, agentId);
	const agentUsingNow = useRef(agentUsing);
	useEffect(() => {
		agentUsingNow.current = agentUsing;
	}, [agentUsing]);
	// Taking over or handing back switches input on the open connection, without reconnecting.
	useEffect(() => {
		viewOnlyNow.current = viewOnly;
		if (connected.current) connected.current.viewOnly = viewOnly;
	}, [viewOnly]);

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
		// noVNC sends the paste shortcut to the desktop as keys, which pastes the
		// desktop's own clipboard, not the person's. Kept from noVNC, the
		// shortcut pastes in this page instead, and the text goes to the
		// desktop's clipboard and is pasted there with Ctrl+V, the shortcut its
		// Linux apps know, Command on a Mac included.
		let pasting = false;
		const keepPasteShortcut = (event: KeyboardEvent) => {
			if (viewOnlyNow.current || !isPasteShortcut(event)) return;
			pasting = true;
			event.stopPropagation();
		};
		const pasteIntoDesktop = (event: ClipboardEvent) => {
			if (!pasting || !viewer) return;
			pasting = false;
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			viewer.clipboardPasteFrom(text);
			viewer.sendKey(XK_CONTROL_L, "ControlLeft", true);
			viewer.sendKey(XK_V, "KeyV");
			viewer.sendKey(XK_CONTROL_L, "ControlLeft", false);
		};
		element.addEventListener("keydown", keepPasteShortcut, { capture: true });
		document.addEventListener("paste", pasteIntoDesktop);
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
			connected.current = opened;
			opened.scaleViewport = true;
			opened.viewOnly = viewOnlyNow.current;
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
			element.removeEventListener("keydown", keepPasteShortcut, { capture: true });
			document.removeEventListener("paste", pasteIntoDesktop);
			viewer?.disconnect();
			connected.current = undefined;
		};
	}, [threadId, agentId, attempt]);

	return (
		<div className="relative aspect-[4/3] w-full overflow-hidden rounded-panel bg-list">
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

/** X11's keysyms for the left Control key and `v`, which noVNC sends as they are. */
const XK_CONTROL_L = 0xffe3;
const XK_V = 0x0076;

/** ⌘V on a Mac, Ctrl+V elsewhere, without the Shift or Alt of a different shortcut. */
function isPasteShortcut(event: KeyboardEvent): boolean {
	const command = navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey;
	return command && !event.shiftKey && !event.altKey && event.code === "KeyV";
}

const STANDING_TEXT: Record<Exclude<Standing, "connected">, string> = {
	connecting: "Starting the desktop…",
	ended: "The desktop couldn't be reached. Close it and open it again to retry.",
	idle: `Disconnected after ${IDLE_TIMEOUT_MINUTES} minutes unused, so the sandbox can pause.`,
};

function desktopUrl(threadId: string, agentId: string) {
	const url = new URL(`${apiBaseUrl}/threads/${threadId}/agents/${agentId}/desktop`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
