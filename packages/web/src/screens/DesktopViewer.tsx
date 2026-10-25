import type RFB from "@novnc/novnc";
import type { Agent, DesktopUnreachedSite } from "@sugabots/contracts";
import { cn } from "cn";
import { Monitor } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { useDesktopInUse, useUnreachedSites } from "@/lib/desktop.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { InfoTip } from "@/ui/info-tip.tsx";
import { AllowSiteDialog } from "./AllowSiteDialog.tsx";
import { AllowUnreachedSitesDialog } from "./AllowUnreachedSitesDialog.tsx";

/**
 * An agent's desktop opened beside its chat, live: where the browser it
 * drives is shown. Opening it starts the desktop, and the sandbox if it was
 * paused, so the first connection can take a few seconds; it comes over a
 * WebSocket the API relays from the sandbox. The person watches until they
 * take over, if the pod lets them use desktops, and can hand control back.
 *
 * A site the sandbox can't reach looks like a broken connection in its
 * browser, and a page often loads its pictures and styles from other sites
 * nobody could guess. So while the person has control, the bar says the
 * sandbox only reaches allowed sites, and a banner over the desktop says when
 * pages in its browser tried to reach others, for those who may change the
 * pod's sites to review and allow.
 */
export function DesktopStage({
	threadId,
	podId,
	podName,
	agent,
	mayUse,
	mayAllowSites,
	onClose,
}: {
	threadId: string;
	podId: string;
	podName: string;
	agent: Agent;
	/** Whether the person holds the pod's `useDesktops`, and so may take over. */
	mayUse: boolean;
	/** Whether the person holds the pod's `manageSandbox`, and so may allow a site. */
	mayAllowSites: boolean;
	onClose: () => void;
}) {
	const [inControl, setInControl] = useState(false);
	const [connected, setConnected] = useState(false);
	const [allowingSite, setAllowingSite] = useState(false);
	const [reviewing, setReviewing] = useState<readonly string[]>();
	const [hiddenFor, setHiddenFor] = useState<string>();
	const agentUsing = useDesktopInUse(threadId, agent.id);
	// Only while it's in use: a desktop left alone disconnects, so its sandbox can pause.
	const unreachedSites = useUnreachedSites(threadId, agent.id, inControl && connected);
	const unreached = inControl && connected ? (unreachedSites.data ?? []) : [];
	const shown = unreached.map((site) => site.host).join(" ");
	return (
		<Stage
			label={`${agent.name}'s desktop`}
			icon={
				<StageMark>
					<Monitor strokeWidth={2} />
				</StageMark>
			}
			title={`${agent.name}'s desktop`}
			byline="Live from the sandbox"
			onClose={onClose}
		>
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
				{/* As large as the room allows, keeping the desktop's 16:10 shape, up to its own 1280 pixels across. */}
				<div className="w-[min(1280px,100%,calc((100dvh-13rem)*1.6))]">
					<DesktopScreen
						threadId={threadId}
						agentId={agent.id}
						viewOnly={!inControl}
						onConnectedChange={setConnected}
						overlay={
							unreached.length > 0 &&
							hiddenFor !== shown && (
								<UnreachedSitesBanner
									agentName={agent.name}
									unreached={unreached}
									mayAllowSites={mayAllowSites}
									onReview={(hosts) => setReviewing(hosts)}
									onHide={() => setHiddenFor(shown)}
								/>
							)
						}
					/>
				</div>
				<div
					className={cn(
						"flex max-w-full items-center gap-2.5 border border-border-strong bg-panel py-1.5 pr-1.5 pl-3 text-sm",
						inControl ? "rounded-2xl" : "rounded-full",
					)}
				>
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
								<b className="font-semibold text-foreground">You</b> have control. What you do here
								is real.
								<span className="flex items-center gap-1 text-muted-foreground">
									This computer only reaches sites that are allowed.
									<InfoTip label="About allowed sites" title="Allowed sites">
										{SITES_EXPLAINED}
									</InfoTip>
								</span>
							</>
						) : agentUsing ? (
							<>
								<b className="font-semibold text-foreground">{agent.name}</b> has control
							</>
						) : (
							<>Watching</>
						)}
					</span>
					{inControl && mayAllowSites && (
						<Button size="sm" variant="secondary" onClick={() => setAllowingSite(true)}>
							Allow a site
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
			<Dialog open={allowingSite} onOpenChange={setAllowingSite}>
				{allowingSite && <AllowSiteDialog podId={podId} onDone={() => setAllowingSite(false)} />}
			</Dialog>
			<Dialog
				open={reviewing !== undefined}
				onOpenChange={(open) => !open && setReviewing(undefined)}
			>
				{reviewing && (
					<AllowUnreachedSitesDialog
						threadId={threadId}
						agentId={agent.id}
						agentName={agent.name}
						podId={podId}
						podName={podName}
						hosts={reviewing}
						onDone={() => {
							setReviewing(undefined);
							void unreachedSites.refetch();
						}}
					/>
				)}
			</Dialog>
		</Stage>
	);
}

/**
 * Across the bottom of the desktop, near the bar: that pages in the agent's
 * browser tried to reach sites the sandbox doesn't allow, to review, or why
 * they can't be allowed. Hiding it hides those sites until others turn up.
 */
export function UnreachedSitesBanner({
	agentName,
	unreached,
	mayAllowSites,
	onReview,
	onHide,
}: {
	agentName: string;
	unreached: readonly DesktopUnreachedSite[];
	mayAllowSites: boolean;
	/** Opens the review of `hosts`, the allowable sites as they are now. */
	onReview: (hosts: readonly string[]) => void;
	onHide: () => void;
}) {
	const allowable = unreached.filter((site) => site.blockedBy === null).map((site) => site.host);
	const blocked = unreached.length - allowable.length;
	return (
		<div
			role="status"
			className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-xl bg-primary py-2.5 pr-2 pl-4 text-primary-foreground text-sm shadow-dialog"
		>
			<p className="m-0 min-w-0 flex-1">
				{allowable.length > 0 ? (
					<>
						Pages in {agentName}'s browser tried to reach {siteCount(allowable.length)} that{" "}
						{allowable.length === 1 ? "isn't" : "aren't"} allowed.
						{!mayAllowSites && " An admin of this pod can allow them."}
					</>
				) : (
					<>
						Pages in {agentName}'s browser tried to reach {siteCount(blocked)} the workspace blocks.
					</>
				)}
			</p>
			{mayAllowSites && allowable.length > 0 && (
				<Button size="sm" variant="secondary" onClick={() => onReview(allowable)}>
					Review sites
				</Button>
			)}
			<CloseButton label="Hide" onClick={onHide} />
		</div>
	);
}

function siteCount(count: number) {
	return count === 1 ? "a site" : `${count} sites`;
}

const SITES_EXPLAINED =
	"A bot's computer only connects to sites its workspace or pod allows, so what's on it can't be sent anywhere else. Any other site shows as “This site can't be reached”, and pages that load parts of themselves from other sites look broken until those are allowed too.";

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
	onConnectedChange,
	overlay,
}: {
	threadId: string;
	agentId: string;
	/** Shows the desktop without sending input. The API enforces it either way. */
	viewOnly: boolean;
	/** Told whenever the desktop connects or stops being connected. */
	onConnectedChange?: (connected: boolean) => void;
	/** Shown over the top of the desktop. */
	overlay?: ReactNode;
}) {
	const screen = useRef<HTMLDivElement>(null);
	const connected = useRef<RFB | undefined>(undefined);
	const viewOnlyNow = useRef(viewOnly);
	const [standing, setStanding] = useState<Standing>("connecting");
	useEffect(() => {
		onConnectedChange?.(standing === "connected");
	}, [standing, onConnectedChange]);
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
			viewer?.disconnect();
			connected.current = undefined;
		};
	}, [threadId, agentId, attempt]);

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
			{overlay}
		</div>
	);
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
