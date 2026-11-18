import type { Channel } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useStartChat } from "@/lib/chats.ts";
import { conversationLink } from "@/lib/links.ts";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * A + that starts a thread in `channel`, named in a dialog, and opens it once it
 * is made.
 */
export function NewThreadButton({ channel, className }: { channel: Channel; className?: string }) {
	const [naming, setNaming] = useState(false);
	const startChat = useStartChat(channel);
	const navigate = useNavigate();
	return (
		<>
			<IconButton
				label={`New thread in ${channel.name}`}
				size="sm"
				onClick={() => setNaming(true)}
				className={className}
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
