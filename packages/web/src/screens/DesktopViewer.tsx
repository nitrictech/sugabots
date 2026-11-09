import type RFB from "@novnc/novnc";
import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Keyboard, Monitor, X } from "lucide-react";
import { type FormEvent, type Ref, type RefObject, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { usePanelKeys } from "@/lib/panel-keys.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { BACK_BUTTON } from "@/ui/back-button.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

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
	const access = useSandboxAccess();
	const sandboxes = access.data;
	const may = useWorkspacePermissions();
	const backToChat = useBackToHere("Chat");
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	// For a phone's own view, which covers everything; a wider screen's `Stage` has its own.
	const phoneKeys = usePanelKeys<HTMLElement>(onClose);
	// What stands between the bot and a computer, if anything: the workspace has none, or the bot doesn't use one.
	const missing =
		sandboxes === undefined
			? undefined
			: !sandboxes.enabled
				? "workspace"
				: !agent.usesSandbox
					? "bot"
					: null;
	// What the computer shows: its screen, or why there is none.
	const content = (
		<>
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
			) : access.isError ? (
				<EmptyState title="Could not check for a computer">
					The API did not answer. Reload this page to try again.
				</EmptyState>
			) : null}
		</>
	);
	// A phone shows it alone, over everything, with only a way out.
	if (phone) {
		return (
			<section
				aria-label={`${agent.name}'s computer`}
				{...phoneKeys}
				className="fixed inset-0 outline-none z-50 flex flex-col bg-black pt-safe-or-3 pb-safe-or-4"
			>
				<div className="shrink-0 px-4">
					<button type="button" aria-label="Close" onClick={onClose} className={BACK_BUTTON}>
						<X aria-hidden size={20} strokeWidth={2.25} />
					</button>
				</div>
				<div className="flex min-h-0 flex-1 flex-col pt-3">{content}</div>
			</section>
		);
	}
	return (
		<Stage
			label={`${agent.name}'s computer`}
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
			{content}
		</Stage>
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
	const keyboard = useRef<HTMLTextAreaElement>(null);
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center gap-4">
			{/* As large as the room left by the controls allows, keeping the desktop's 4:3 shape. */}
			<div className="@container-size flex min-h-0 w-full flex-1 items-center justify-center">
				<div className="w-desktop-screen">
					<DesktopScreen
						threadId={threadId}
						agentId={agent.id}
						viewOnly={!inControl}
						offersReconnect
						keyboardInput={keyboard}
					/>
				</div>
			</div>
			<div className="flex max-w-full items-center gap-2.5 rounded-full border border-border-strong bg-panel py-1.5 pr-1.5 pl-3 text-xs">
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
							<b className="font-semibold text-foreground">You</b> have control
						</>
					) : agentUsing ? (
						<>
							<b className="font-semibold text-foreground">{agent.name}</b> has control
						</>
					) : (
						<>Watching</>
					)}
				</span>
				{inControl && (
					<Button
						size="sm"
						variant="secondary"
						aria-label="Keyboard"
						className="hidden pointer-coarse:inline-flex"
						// Keeps an open keyboard's field focused, so this click can close it.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							const field = keyboard.current;
							if (document.activeElement === field) field?.blur();
							else field?.focus();
						}}
					>
						<Keyboard aria-hidden />
					</Button>
				)}
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
			className="overflow-hidden rounded-xl border border-border bg-panel"
		>
			<div className="relative">
				{/* Covered by the button that opens the desktop, which reconnects there. */}
				<DesktopScreen threadId={threadId} agentId={agentId} viewOnly offersReconnect={false} />
				<button
					type="button"
					onClick={onOpen}
					aria-label={`Open ${agentName}'s desktop`}
					className="focus-ring absolute inset-0 cursor-zoom-in"
				/>
			</div>
			<p className="m-0 flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
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
/** noVNC's JPEG quality, 0 to 9, which the desktop encodes changing regions at. */
const DESKTOP_JPEG_QUALITY = 4;
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
	offersReconnect,
	keyboardInput,
}: {
	threadId: string;
	agentId: string;
	/** Shows the desktop without sending input. The API enforces it either way. */
	viewOnly: boolean;
	/** Shows a Reconnect button once disconnected, for a screen nothing else covers. */
	offersReconnect: boolean;
	/**
	 * Given while not `viewOnly`, a hidden field whose typing goes to the
	 * desktop; focusing it opens a touch screen's keyboard, which a phone only
	 * shows for a text field.
	 */
	keyboardInput?: Ref<HTMLTextAreaElement>;
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
			if (viewOnlyNow.current || !isCommandShortcut(event, "KeyV")) return;
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
			pressControlWith(viewer, XK_V, "KeyV");
		};
		// On a Mac, noVNC sends ⌘C as Super+C, which the desktop's Linux apps
		// don't treat as copying.
		const copyWithControl = (event: KeyboardEvent) => {
			if (!IS_MAC || viewOnlyNow.current || !viewer) return;
			const copyKey = COPY_KEYS.find(({ code }) => isCommandShortcut(event, code));
			if (!copyKey) return;
			event.preventDefault();
			event.stopPropagation();
			pressControlWith(viewer, copyKey.keysym, copyKey.code);
		};
		// What the desktop copies arrives from the network, outside any gesture
		// of the person's, and most browsers only let a page write the clipboard
		// shortly after one. Usually the copy shortcut just pressed counts; when
		// it doesn't, the text waits for the person's next click or key.
		let copied: string | undefined;
		const copyOut = () => {
			if (copied === undefined) return;
			const text = copied;
			copied = undefined;
			void navigator.clipboard.writeText(text).catch(() => {
				copied ??= text;
			});
		};
		const copyOutWhileInControl = (event: Event) => {
			if (viewOnlyNow.current) return;
			copied = (event as CustomEvent<{ text: string }>).detail.text;
			copyOut();
		};
		element.addEventListener("keydown", keepPasteShortcut, { capture: true });
		element.addEventListener("keydown", copyWithControl, { capture: true });
		document.addEventListener("paste", pasteIntoDesktop);
		for (const event of GESTURE_EVENTS) element.addEventListener(event, copyOut, { capture: true });
		// A hidden page's connection may be closed, and only reported closed once the page is shown.
		let hiddenWhileConnected = document.hidden;
		let droppedWhileHidden = false;
		const unusedTooLong = () =>
			!agentUsingNow.current && Date.now() - lastUsedAt.current >= IDLE_TIMEOUT_MINUTES * 60_000;
		// Waking the sandbox after a long absence is left to the Reconnect button.
		const reconnect = () =>
			unusedTooLong() ? setStanding("idle") : setAttempt((count) => count + 1);
		const reconnectWhenShown = () => {
			if (document.hidden) {
				hiddenWhileConnected = true;
				return;
			}
			if (droppedWhileHidden) reconnect();
		};
		document.addEventListener("visibilitychange", reconnectWhenShown);
		const idleCheck = setInterval(() => {
			if (agentUsingNow.current) used();
			if (!viewer || !unusedTooLong()) return;
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
			// Below noVNC's default of 6: over a long link, smaller JPEG updates
			// settle a scroll about a quarter sooner, for a little softness.
			opened.qualityLevel = DESKTOP_JPEG_QUALITY;
			opened.viewOnly = viewOnlyNow.current;
			opened.background = "var(--color-background)";
			opened.addEventListener("connect", () => setStanding("connected"));
			opened.addEventListener("clipboard", copyOutWhileInControl);
			opened.addEventListener("disconnect", () => {
				if (viewer !== opened) return;
				viewer = undefined;
				connected.current = undefined;
				if (!hiddenWhileConnected) return setStanding("ended");
				if (!document.hidden) return reconnect();
				droppedWhileHidden = true;
				setStanding("connecting");
			});
		});
		return () => {
			unmounted = true;
			clearInterval(idleCheck);
			for (const event of INPUT_EVENTS) element.removeEventListener(event, used, { capture: true });
			element.removeEventListener("keydown", keepPasteShortcut, { capture: true });
			element.removeEventListener("keydown", copyWithControl, { capture: true });
			document.removeEventListener("paste", pasteIntoDesktop);
			for (const event of GESTURE_EVENTS) {
				element.removeEventListener(event, copyOut, { capture: true });
			}
			document.removeEventListener("visibilitychange", reconnectWhenShown);
			const closing = viewer;
			viewer = undefined;
			closing?.disconnect();
			connected.current = undefined;
		};
	}, [threadId, agentId, attempt]);

	return (
		<div className="relative aspect-4/3 w-full overflow-hidden rounded-panel bg-list">
			<div ref={screen} className="absolute inset-0" />
			{keyboardInput && !viewOnly && (
				<KeyboardField
					ref={keyboardInput}
					viewer={connected}
					onTyped={() => {
						lastUsedAt.current = Date.now();
					}}
				/>
			)}
			{standing !== "connected" && (
				<div className="absolute inset-0 grid place-items-center content-center gap-3 px-6 text-center text-muted-foreground text-xs">
					<p>{STANDING_TEXT[standing]}</p>
					{offersReconnect && (standing === "idle" || standing === "ended") && (
						<Button variant="outline" onClick={() => setAttempt((count) => count + 1)}>
							Reconnect
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

/** X11's keysyms for the keys sent by hand, which noVNC passes on as they are. */
const XK_CONTROL_L = 0xffe3;
const XK_SUPER_L = 0xffeb;
const XK_SUPER_R = 0xffec;
const XK_C = 0x0063;
const XK_V = 0x0076;
const XK_X = 0x0078;
const XK_BACKSPACE = 0xff08;
const XK_RETURN = 0xff0d;

/**
 * What the keyboard field holds before any typing: text for Backspace to
 * delete, since a field with nothing to delete reports no input, and for an
 * on-screen keyboard to revise as it corrects a word. noVNC's own app does the same.
 */
const KEYBOARD_FIELD_FILLER = "_".repeat(100);

/**
 * A hidden field that sends what is typed into it to the desktop, by the
 * difference each change makes, as on-screen keyboards report little else
 * dependably: Android's give most keys no key code, and any may replace a
 * word it has corrected.
 */
function KeyboardField({
	ref,
	viewer,
	onTyped,
}: {
	ref: Ref<HTMLTextAreaElement>;
	viewer: RefObject<RFB | undefined>;
	onTyped: () => void;
}) {
	const sent = useRef(KEYBOARD_FIELD_FILLER);
	const refill = (field: HTMLTextAreaElement) => {
		field.value = KEYBOARD_FIELD_FILLER;
		field.setSelectionRange(field.value.length, field.value.length);
		sent.current = KEYBOARD_FIELD_FILLER;
	};
	const typed = (event: FormEvent<HTMLTextAreaElement>) => {
		const field = event.currentTarget;
		if (viewer.current) typeDifference(viewer.current, sent.current, field.value);
		sent.current = field.value;
		onTyped();
		// Refilled between words only: a keyboard mid-word revises the field's text.
		const composing = (event.nativeEvent as InputEvent).isComposing;
		const length = field.value.length;
		const filler = KEYBOARD_FIELD_FILLER.length;
		if (!composing && (length < filler / 2 || length > filler * 2)) refill(field);
	};
	// While typing, a tap on the desktop would otherwise focus noVNC's screen and close the keyboard.
	const setDesktopTakesFocus = (takesFocus: boolean) => {
		if (viewer.current) viewer.current.focusOnClick = takesFocus;
	};
	return (
		<textarea
			ref={ref}
			aria-label="Type on the desktop"
			defaultValue={KEYBOARD_FIELD_FILLER}
			autoCapitalize="off"
			autoComplete="off"
			autoCorrect="off"
			spellCheck={false}
			// Transparent, not hidden: a phone won't focus a field it can't display.
			className="pointer-events-none absolute bottom-0 left-0 size-px resize-none opacity-0"
			onFocus={(event) => {
				refill(event.currentTarget);
				setDesktopTakesFocus(false);
			}}
			onBlur={() => setDesktopTakesFocus(true)}
			onInput={typed}
		/>
	);
}

/** Sends the desktop the Backspaces and characters that turn `before` into `after`. */
function typeDifference(desktop: RFB, before: string, after: string) {
	const was = Array.from(before);
	const now = Array.from(after);
	let kept = 0;
	while (kept < was.length && kept < now.length && was[kept] === now[kept]) kept++;
	for (let index = kept; index < was.length; index++) desktop.sendKey(XK_BACKSPACE, "Backspace");
	// No key code, so the desktop types the character itself rather than a key its layout maps.
	for (const character of now.slice(kept)) desktop.sendKey(keysymFor(character), "");
}

/** X11's keysym for a character: Latin-1's as they are, the rest of Unicode's offset by 0x1000000. */
function keysymFor(character: string): number {
	if (character === "\n") return XK_RETURN;
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint < 0x100 ? codePoint : 0x1000000 | codePoint;
}

const COPY_KEYS = [
	{ code: "KeyC", keysym: XK_C },
	{ code: "KeyX", keysym: XK_X },
] as const;

/** The person's input a browser counts as a gesture, letting the page write the clipboard. */
const GESTURE_EVENTS = ["pointerdown", "keydown"] as const;

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** ⌘ and `code` on a Mac, Ctrl and `code` elsewhere, without the Shift or Alt of a different shortcut. */
function isCommandShortcut(event: KeyboardEvent, code: string): boolean {
	const command = IS_MAC ? event.metaKey : event.ctrlKey;
	return command && !event.shiftKey && !event.altKey && event.code === code;
}

/**
 * Presses Ctrl and `keysym` on the desktop, the shortcuts its Linux apps know.
 * ⌘, which noVNC has already sent down as Super, is let go first, or the app
 * would see Super+Ctrl.
 */
function pressControlWith(viewer: RFB, keysym: number, code: string) {
	if (IS_MAC) {
		viewer.sendKey(XK_SUPER_L, "MetaLeft", false);
		viewer.sendKey(XK_SUPER_R, "MetaRight", false);
	}
	viewer.sendKey(XK_CONTROL_L, "ControlLeft", true);
	viewer.sendKey(keysym, code);
	viewer.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

const STANDING_TEXT: Record<Exclude<Standing, "connected">, string> = {
	connecting: "Starting the desktop…",
	ended: "The desktop couldn't be reached.",
	idle: `Disconnected after ${IDLE_TIMEOUT_MINUTES} minutes unused, so the sandbox can pause.`,
};

function desktopUrl(threadId: string, agentId: string) {
	const url = new URL(`${apiBaseUrl}/threads/${threadId}/agents/${agentId}/desktop`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
