import { Monitor } from "lucide-react";
import { useState } from "react";
import { Tooltip } from "@/ui/tooltip.tsx";
import { DesktopViewerDialog } from "./DesktopViewer.tsx";

/**
 * The way into an agent's sandbox desktop from the top of its chat, there at
 * any time. While the agent is using the desktop it says so in the bot's
 * colour, with a pulse, so people notice there's something to watch.
 */
export function SandboxButton({
	threadId,
	agentId,
	agentName,
	inUse,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
	/** Whether the agent is using the desktop right now. */
	inUse: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			{inUse ? (
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-label={`${agentName} is using the sandbox. Open its desktop`}
					className="focus-ring flex h-9 shrink-0 items-center gap-2 rounded-full bg-bot-tint px-3 font-medium text-bot-text text-sm transition-colors max-md:px-2.5"
				>
					<span aria-hidden className="relative flex size-2">
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
						<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
					</span>
					<span className="max-md:hidden">Sandbox in use</span>
					<Monitor aria-hidden size={17} strokeWidth={2} className="md:hidden" />
				</button>
			) : (
				<Tooltip label="Sandbox">
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-label={`Open ${agentName}'s sandbox desktop`}
						className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-soft-foreground transition-colors hover:bg-chip"
					>
						<Monitor size={19} strokeWidth={2} />
					</button>
				</Tooltip>
			)}
			<DesktopViewerDialog
				threadId={threadId}
				agentId={agentId}
				agentName={agentName}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
}
