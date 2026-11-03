import type { Pod } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot, Hash, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useStartChat } from "@/lib/chats.ts";
import { agentChatLink, conversationLink } from "@/lib/links.ts";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * What starts a channel in `pod`, absent from a Personal pod, which has none,
 * and the dialog that names it, which must be rendered for it to open. It
 * opens the channel once it is made.
 */
function useNewChannel(pod: Pod): { start?: () => void; dialog: ReactNode } {
	const [naming, setNaming] = useState(false);
	const startChat = useStartChat(pod);
	const navigate = useNavigate();
	return {
		start: pod.kind === "shared" ? () => setNaming(true) : undefined,
		dialog: (
			<Dialog open={naming} onOpenChange={setNaming}>
				<ChatNameDialog
					title="New channel"
					action="Create"
					onSave={async (name) => {
						const started = await startChat.mutateAsync(name);
						setNaming(false);
						await navigate(conversationLink({ pod, conversationId: started.id }));
					}}
				/>
			</Dialog>
		),
	};
}

/**
 * What starts a bot in `pod`, absent where the viewer may not make one, and
 * the dialog that makes it, which must be rendered for it to open. It opens
 * the bot's channel once it is made.
 */
export function useNewBot(pod: Pod): { start?: () => void; dialog: ReactNode } {
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	return {
		start: pod.permissions.createAgents ? () => setCreating(true) : undefined,
		dialog: (
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					podId={pod.id}
					onCreated={async (agent) => {
						setCreating(false);
						await navigate(agentChatLink({ pod, agent }));
					}}
				/>
			</Dialog>
		),
	};
}

/**
 * A + that offers a new channel or a new bot in `pod`, whichever the viewer
 * may make, or nothing when they may make neither.
 */
export function NewInPodMenu({ pod, className }: { pod: Pod; className?: string }) {
	const channel = useNewChannel(pod);
	const bot = useNewBot(pod);
	if (!channel.start && !bot.start) return null;
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<IconButton
							label={`New in ${pod.name}`}
							size="sm"
							className={cn("data-popup-open:bg-row-selected", className)}
						>
							<Plus strokeWidth={2.2} />
						</IconButton>
					}
				/>
				<DropdownMenuContent align="start" className="min-w-40">
					{channel.start && (
						<DropdownMenuItem onClick={channel.start}>
							<Hash aria-hidden className="text-muted-foreground" />
							New channel
						</DropdownMenuItem>
					)}
					{bot.start && (
						<DropdownMenuItem onClick={bot.start}>
							<Bot aria-hidden className="text-muted-foreground" />
							New bot
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{channel.dialog}
			{bot.dialog}
		</>
	);
}
