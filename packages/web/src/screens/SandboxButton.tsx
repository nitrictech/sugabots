import type { Agent, Pod } from "@sugabots/contracts";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { useChat } from "@/lib/chats.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { DesktopViewerDialog } from "./DesktopViewer.tsx";

/**
 * The bot's sandbox, for the top of its chat: there while the workspace has
 * sandboxes and the bot uses one.
 */
export function ChatSandbox({ agent, pod }: { agent: Agent; pod: Pod }) {
	const threadId = useChat(pod, agent.id).data?.mainThreadId;
	const sandboxesOn = useSandboxAccess().data?.enabled === true;
	const inUse = useDesktopInUse(threadId, agent.id);
	if (!agent.usesSandbox || !sandboxesOn || !threadId) return null;
	return (
		<SandboxButton
			threadId={threadId}
			agentId={agent.id}
			agentName={agent.name}
			viewOnly={!pod.permissions.useDesktops}
			inUse={inUse}
		/>
	);
}

/**
 * The way into an agent's sandbox desktop from the top of its chat, there at
 * any time. While the agent is using the desktop it says so in the bot's
 * colour, with a pulse, so people notice there's something to watch.
 */
export function SandboxButton({
	threadId,
	agentId,
	agentName,
	viewOnly,
	inUse,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
	viewOnly: boolean;
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
					className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-full bg-bot-tint px-3 font-medium text-bot-text text-sm transition-colors max-md:px-2.5"
				>
					<span aria-hidden className="relative flex size-2">
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
						<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
					</span>
					<span className="max-md:hidden">Sandbox in use</span>
					<Monitor aria-hidden size={17} strokeWidth={2} className="md:hidden" />
				</button>
			) : (
				<IconButton
					label="Sandbox desktop"
					variant="bar"
					onClick={() => setOpen(true)}
					className="size-8"
				>
					<Monitor size={18} strokeWidth={2} />
				</IconButton>
			)}
			<DesktopViewerDialog
				threadId={threadId}
				agentId={agentId}
				agentName={agentName}
				viewOnly={viewOnly}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
}
