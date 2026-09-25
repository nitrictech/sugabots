import type { PodSandboxStatus } from "@sugabots/contracts";
import { cn } from "cn";
import { ExternalLink, Maximize2, Minimize2, SquareTerminal, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { usePodDesktop, usePodSandbox } from "@/lib/sandbox-provider.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * Whether a pod's sandbox is up, beside the pod's name: a terminal mark with a
 * dot for its state. Nothing at all until an agent in the pod has needed one,
 * since most pods never will. The tooltip says who is using it, or when it was
 * last used; clicking it opens the sandbox's desktop, for images that have one.
 */
export function PodSandboxChip({ podId, podName }: { podId: string; podName: string }) {
	const { data: status } = usePodSandbox(podId);
	const [watching, setWatching] = useState(false);
	if (!status || status.state === "none") return null;
	const description = describe(status);
	return (
		<>
			<Tooltip label={`${description}. Click to watch its desktop.`}>
				<button
					type="button"
					aria-label={`${description}. Watch its desktop`}
					aria-pressed={watching}
					onClick={() => setWatching((open) => !open)}
					className={cn(
						"focus-ring flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-subtle-foreground hover:bg-sidebar-accent",
						watching && "bg-sidebar-accent text-heading",
					)}
				>
					<SquareTerminal aria-hidden size={14} strokeWidth={2} />
					<span
						aria-hidden
						className={cn(
							"size-1.5 rounded-full",
							status.state === "in_use" && "animate-pulse bg-success motion-reduce:animate-none",
							status.state === "idle" && "border border-muted-foreground/60",
							status.state === "paused" && "bg-muted-foreground/40",
							status.state === "lost" && "bg-warning",
						)}
					/>
				</button>
			</Tooltip>
			{watching &&
				createPortal(
					<DesktopPanel
						podId={podId}
						podName={podName}
						status={status}
						onClose={() => setWatching(false)}
					/>,
					document.body,
				)}
		</>
	);
}

/*
 * The sandbox's screen, live, in a panel that floats over the corner of the
 * app so the chat stays usable beside it. Anyone watching can also click and
 * type into it: it is the same desktop the agents use.
 */
function DesktopPanel({
	podId,
	podName,
	status,
	onClose,
}: {
	podId: string;
	podName: string;
	status: PodSandboxStatus;
	onClose: () => void;
}) {
	const [large, setLarge] = useState(false);
	const desktop = usePodDesktop(podId, status.state !== "lost");
	const viewer = desktop.data?.viewer;
	const src = viewer ? viewerUrl(viewer) : undefined;

	return (
		<section
			aria-label={`${podName} sandbox desktop`}
			className={cn(
				"fixed right-4 bottom-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-lg",
				large ? "h-[min(85vh,820px)] w-[min(92vw,1280px)]" : "h-[440px] w-[min(92vw,680px)]",
			)}
		>
			<header className="flex items-center gap-2 border-border-subtle border-b px-3 py-2">
				<SquareTerminal aria-hidden size={15} className="text-subtle-foreground" />
				<h2 className="min-w-0 flex-1 truncate font-semibold text-heading text-md">
					{podName} <span className="font-normal text-muted-foreground">· {describe(status)}</span>
				</h2>
				{src && (
					<IconButton
						label="Open in a new tab"
						render={<a href={src} target="_blank" rel="noreferrer" />}
					>
						<ExternalLink />
					</IconButton>
				)}
				<IconButton label={large ? "Make smaller" : "Make larger"} onClick={() => setLarge(!large)}>
					{large ? <Minimize2 /> : <Maximize2 />}
				</IconButton>
				<IconButton label="Close" onClick={onClose}>
					<X />
				</IconButton>
			</header>
			<div className="relative min-h-0 flex-1 bg-sunken">
				{src ? (
					<iframe title={`${podName} sandbox desktop`} src={src} className="size-full border-0" />
				) : (
					<p className="m-auto flex h-full max-w-sm items-center justify-center p-6 text-center text-muted-foreground text-sm">
						{desktop.isPending && status.state !== "lost"
							? "Connecting to the desktop…"
							: emptyReason(status)}
					</p>
				)}
			</div>
		</section>
	);
}

/** noVNC's page, through the development server, with its websocket on the same path. */
function viewerUrl(viewer: string): string {
	const base = `sandbox-desktop/${viewer}`;
	const query = new URLSearchParams({
		autoconnect: "1",
		reconnect: "1",
		resize: "scale",
		path: `${base}/websockify`,
	});
	return `/${base}/vnc.html?${query}`;
}

function emptyReason(status: PodSandboxStatus): string {
	switch (status.state) {
		case "paused":
			return "The sandbox is paused while nobody is using it. It wakes when an agent needs it.";
		case "lost":
			return "The sandbox is gone, so there is no desktop to show.";
		default:
			return "This sandbox has no desktop. Set the workspace's sandbox image to one with a desktop, such as sugabots/sandbox-desktop.";
	}
}

function describe(status: PodSandboxStatus): string {
	switch (status.state) {
		case "in_use":
			return `Sandbox in use by ${status.usedBy.map((agent) => `@${agent.handle}`).join(", ")}`;
		case "idle":
			return status.lastUsedAt
				? `Sandbox idle, last used ${sinceText(new Date(status.lastUsedAt))}`
				: "Sandbox idle";
		case "paused":
			return "Sandbox paused";
		case "lost":
			return "Sandbox lost";
		case "none":
			return "No sandbox";
	}
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function sinceText(then: Date): string {
	const minutes = Math.round((then.getTime() - Date.now()) / 60_000);
	if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return relative.format(hours, "hour");
	return relative.format(Math.round(hours / 24), "day");
}
