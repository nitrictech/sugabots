import type { Pod } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Archive, Ellipsis, Pencil } from "lucide-react";
import { useState } from "react";
import { useArchiveChat, useRenameChat } from "@/lib/chats.ts";
import { podLink } from "@/lib/links.ts";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Beside a channel's name, for whoever may change the pod: renaming the
 * channel, and, unless it is the pod's first, archiving it, which takes it off
 * the pod's list and goes back to the pod. Its threads stay where they are.
 */
export function ChatMenu({
	pod,
	conversationId,
	name,
	archivable,
}: {
	pod: Pod;
	conversationId: string;
	name: string;
	archivable: boolean;
}) {
	const rename = useRenameChat(conversationId);
	const archive = useArchiveChat(conversationId);
	const navigate = useNavigate();
	const [renaming, setRenaming] = useState(false);
	const [archiving, setArchiving] = useState(false);

	async function archiveAndLeave() {
		try {
			await archive.mutateAsync();
		} catch {
			return;
		}
		setArchiving(false);
		await navigate(podLink(pod));
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<IconButton label={`More for ${name}`} variant="bar" className="size-8">
							<Ellipsis size={18} strokeWidth={2} />
						</IconButton>
					}
				/>
				<DropdownMenuContent align="end" className="min-w-48">
					<DropdownMenuItem onClick={() => setRenaming(true)}>
						<Pencil aria-hidden size={16} />
						Rename channel
					</DropdownMenuItem>
					{archivable && (
						<DropdownMenuItem variant="destructive" onClick={() => setArchiving(true)}>
							<Archive aria-hidden size={16} />
							Archive channel
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={renaming} onOpenChange={setRenaming}>
				<ChatNameDialog
					title="Rename channel"
					name={name}
					action="Save"
					onSave={async (renamed) => {
						await rename.mutateAsync(renamed);
						setRenaming(false);
					}}
				/>
			</Dialog>
			<DeleteDialog
				open={archiving}
				onOpenChange={setArchiving}
				title={`Archive ${name}?`}
				description="It leaves the pod's list for everyone. Threads started from it stay."
				confirmLabel="Archive"
				pending={archive.isPending}
				error={archive.isError ? "The channel was not archived. Try again." : undefined}
				onDelete={archiveAndLeave}
			/>
		</>
	);
}
