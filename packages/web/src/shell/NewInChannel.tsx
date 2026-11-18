import type { Channel } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useStartChat, useStartInterview } from "@/lib/chats.ts";
import { botLink, conversationLink } from "@/lib/links.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { NewBotDialog } from "@/shell/NewBot.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * A + that starts a thread in `channel`, named in a dialog, and opens it once it
 * is made.
 */
export function NewInChannelMenu({ channel, className }: { channel: Channel; className?: string }) {
	const [naming, setNaming] = useState(false);
	const startChat = useStartChat(channel);
	const navigate = useNavigate();
	return (
		<>
			<IconButton
				label={`New thread in ${channel.name}`}
				size="sm"
				onClick={() => setNaming(true)}
				className={cn("data-popup-open:bg-row-selected", className)}
			>
				<Plus strokeWidth={2.2} />
			</IconButton>
			<Dialog open={naming} onOpenChange={setNaming}>
				<ChatNameDialog
					title="New thread"
					action="Create"
					onSave={async (name) => {
						const started = await startChat.mutateAsync(name);
						setNaming(false);
						await navigate(conversationLink({ channel, conversationId: started.id }));
					}}
				/>
			</Dialog>
		</>
	);
}

/**
 * What starts a bot, absent where the viewer may not make one, and the dialog
 * that makes it, which must be rendered for it to open. It opens the bot once
 * it is made, on the task in which it interviews its maker when it has one.
 */
export function useNewBot(): { start?: () => void; dialog: ReactNode } {
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const may = useWorkspacePermissions();
	const interview = useStartInterview();
	return {
		start: may.createBots ? () => setCreating(true) : undefined,
		dialog: (
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewBotDialog
					onCreated={async (bot) => {
						setCreating(false);
						const task = await interview.mutateAsync(bot.id).catch(() => null);
						if (task) await navigate(conversationLink({ bot, conversationId: task.id }));
						else await navigate(botLink(bot));
					}}
				/>
			</Dialog>
		),
	};
}
