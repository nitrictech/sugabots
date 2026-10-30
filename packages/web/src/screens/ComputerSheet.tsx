import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Monitor } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { useUpdateAgent } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { DialogContent, DialogTitle } from "@/ui/dialog.tsx";
import { DesktopScreen } from "./DesktopViewer.tsx";

/**
 * A bot's computer as a phone first shows it, in a sheet from the foot of a
 * chat: its screen, live and small, which opens it full screen; or, while it
 * has none, why, and for somebody who may, the way to give it one.
 */
export function ComputerSheet({
	agent,
	pod,
	threadId,
	onOpenFull,
	onDismiss,
}: {
	agent: Agent;
	pod: Pod;
	/** The conversation the desktop is watched from. */
	threadId: string;
	/** Opens the desktop full screen, where it can be taken over. */
	onOpenFull: () => void;
	/** Closes the sheet, when it is pulled down. */
	onDismiss: () => void;
}) {
	const drag = useDragToDismiss(onDismiss);
	const sandboxes = useSandboxAccess().data;
	const may = useWorkspacePermissions();
	const update = useUpdateAgent(agent.id);
	const backToChat = useBackToHere("Chat");
	const title = `${agent.name}'s computer`;
	// What stands between the bot and a computer: the workspace has none, or the bot doesn't use one.
	const missing =
		sandboxes === undefined
			? undefined
			: !sandboxes.enabled
				? "workspace"
				: !agent.usesSandbox
					? "bot"
					: null;

	return (
		<DialogContent
			sheetOnPhone
			showCloseButton={false}
			className={cn("gap-4 pt-0", !drag.dragging && "transition-transform duration-200")}
			style={{ transform: drag.offset > 0 ? `translateY(${drag.offset}px)` : undefined }}
		>
			{/* Pulled down past a little way, it goes; let go short of that, it springs back. */}
			<div
				aria-hidden
				{...drag.handlers}
				className="-mx-4 flex h-6 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing"
			>
				<span className="h-[5px] w-9 rounded-full bg-border-strong" />
			</div>
			{/* Named for a screen reader, which hears what the sheet is; the screen shows it. */}
			<DialogTitle className="sr-only">{title}</DialogTitle>
			{missing === null ? (
				<div className="flex flex-col gap-3">
					<button
						type="button"
						onClick={onOpenFull}
						aria-label={`Open ${title} full screen`}
						className="focus-ring overflow-hidden rounded-[12px] border border-border-strong"
					>
						<DesktopScreen
							threadId={threadId}
							agentId={agent.id}
							viewOnly
							offersReconnect={false}
						/>
					</button>
					<Button variant="outline" className="h-11 text-[15px]" onClick={onOpenFull}>
						Open full screen
					</Button>
				</div>
			) : missing === "bot" ? (
				<NoComputer
					text={`${agent.name} doesn't have a computer`}
					detail={
						pod.permissions.updateAgents
							? "Give it one to run commands, browse and make files."
							: "Ask somebody who can edit it to give it one."
					}
				>
					{pod.permissions.updateAgents && (
						<>
							<Button
								className="h-11 w-full text-[15px]"
								disabled={update.isPending}
								onClick={() => update.mutate({ usesSandbox: true })}
							>
								Turn on computer
							</Button>
							{update.error && <Alert>{failureMessage(update.error)}</Alert>}
						</>
					)}
				</NoComputer>
			) : missing === "workspace" ? (
				<NoComputer
					text="Computers aren't set up yet"
					detail={
						may.manageProviders
							? "They're set up once, for the whole workspace."
							: "Ask a workspace admin to set them up."
					}
				>
					{may.manageProviders && (
						<Link
							from="/$workspace"
							to="./settings/$section"
							params={{ section: "sandboxes" }}
							state={backToChat}
							className={buttonStyles({ className: "h-11 w-full text-[15px]" })}
						>
							Set up computers
						</Link>
					)}
				</NoComputer>
			) : null}
		</DialogContent>
	);
}

/** Why there is no computer to show, and what to do about it as `children`. */
function NoComputer({
	text,
	detail,
	children,
}: {
	text: string;
	detail: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 pt-2 text-center">
			<Monitor aria-hidden size={28} strokeWidth={1.5} className="text-subtle-foreground" />
			<p className="m-0 font-medium text-[15px] text-foreground">{text}</p>
			<p className="m-0 text-[14px] text-muted-foreground leading-normal">{detail}</p>
			{children && <div className="mt-3 flex w-full flex-col gap-2">{children}</div>}
		</div>
	);
}

/** How far down, in pixels, a sheet is pulled before letting go closes it. */
const DISMISS_DISTANCE_PX = 80;

/**
 * Pulling a sheet down by its handle: how far it is pulled, for it to follow
 * the finger, and `onDismiss` once it is let go far enough down.
 */
function useDragToDismiss(onDismiss: () => void) {
	const start = useRef<number | null>(null);
	const [offset, setOffset] = useState(0);
	const end = () => {
		if (start.current === null) return;
		start.current = null;
		if (offset > DISMISS_DISTANCE_PX) onDismiss();
		setOffset(0);
	};
	return {
		offset,
		dragging: start.current !== null,
		handlers: {
			onPointerDown: (event: PointerEvent) => {
				start.current = event.clientY;
				event.currentTarget.setPointerCapture(event.pointerId);
			},
			onPointerMove: (event: PointerEvent) => {
				if (start.current !== null) setOffset(Math.max(0, event.clientY - start.current));
			},
			onPointerUp: end,
			onPointerCancel: end,
		},
	};
}
