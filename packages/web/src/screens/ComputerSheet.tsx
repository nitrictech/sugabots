import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Monitor } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";
import { useUpdateBot } from "@/lib/bots.ts";
import { useComputerGap } from "@/lib/computer-providers.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { DialogContent, DialogTitle, SheetHandle } from "@/ui/dialog.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { DesktopScreen } from "./DesktopViewer.tsx";

/**
 * A bot's computer as a phone first shows it, in a sheet from the foot of a
 * chat: its screen, live and small, which opens it full screen; or, while it
 * has none, why, and for somebody who may, the way to give it one.
 */
export function ComputerSheet({
	bot,
	chatId,
	onOpenFull,
	onDismiss,
}: {
	bot: Bot;
	/** The chat the desktop is watched from. */
	chatId: string;
	/** Opens the desktop full screen, where it can be taken over. */
	onOpenFull: () => void;
	/** Closes the sheet, when it is pulled down. */
	onDismiss: () => void;
}) {
	const drag = useDragToDismiss(onDismiss);
	const missing = useComputerGap({ bot });
	const may = useWorkspacePermissions();
	const update = useUpdateBot(bot.id);
	// Whether it uses a computer is the computer's to manage, not the rest of the bot's.
	const mayGiveComputer = bot.permissions.resources.manageComputer;
	const backToChat = useBackToHere("Chat");
	const title = `${bot.name}'s computer`;

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
				<SheetHandle />
			</div>
			<DialogTitle className="sr-only">{title}</DialogTitle>
			{missing === null ? (
				<div className="flex flex-col gap-3">
					<button
						type="button"
						onClick={onOpenFull}
						aria-label={`Open ${title} full screen`}
						className="focus-ring overflow-hidden rounded-xl border border-border-strong"
					>
						<DesktopScreen chatId={chatId} botId={bot.id} viewOnly offersReconnect={false} />
					</button>
					<Button variant="secondary" className="h-11 text-sm" onClick={onOpenFull}>
						Open full screen
					</Button>
				</div>
			) : missing === "bot" ? (
				<EmptyState
					compact
					icon={<Monitor strokeWidth={1.75} />}
					title={`${bot.name} doesn't have a computer`}
					actions={
						mayGiveComputer && (
							<>
								<Button
									className="h-11 w-full text-sm"
									disabled={update.isPending}
									onClick={() => update.mutate({ usesComputer: true })}
								>
									Turn on computer
								</Button>
								{update.error && <Alert>{failureMessage(update.error)}</Alert>}
							</>
						)
					}
				>
					{mayGiveComputer
						? "Give it one to run commands, browse and make files."
						: bot.assistant
							? "Sugabots sets up your Personal Assistant, its computer included."
							: "Ask somebody who can edit it to give it one."}
				</EmptyState>
			) : missing === "workspace" ? (
				<EmptyState
					compact
					icon={<Monitor strokeWidth={1.75} />}
					title="Computers aren't set up yet"
					actions={
						may.manageProviders && (
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "computers" }}
								state={backToChat}
								className={cn(buttonStyles(), "h-11 w-full")}
							>
								Set up computers
							</Link>
						)
					}
				>
					{may.manageProviders
						? "They're set up once, for the whole workspace."
						: "Ask a workspace admin to set them up."}
				</EmptyState>
			) : null}
		</DialogContent>
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
