import type { Channel } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { Archive, Ellipsis, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useArchiveChat, useRenameChat } from "@/lib/chats.ts";
import { channelLink } from "@/lib/links.ts";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/** A channel's main chat or one of its threads, as changing it needs it. */
export interface ChannelConversationToChange {
	channel: Channel;
	conversationId: string;
	name: string;
	/** Whether it may be archived: a thread may, the main chat may not. */
	archivable: boolean;
}

/**
 * Beside a thread's or main chat's name, for whoever may change the channel:
 * renaming it, and archiving a thread, which takes it off the channel's list
 * and goes back to the channel. A phone has these in the details instead.
 */
export function ChatMenu(conversation: ChannelConversationToChange) {
	const noun = conversationNoun(conversation.archivable);
	return (
		<ChannelConversationActions {...conversation}>
			{({ rename, archive }) => (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<IconButton
								label={`More for ${conversation.name}`}
								variant="bar"
								className="size-8 max-md:hidden"
							>
								<Ellipsis size={18} strokeWidth={2} />
							</IconButton>
						}
					/>
					<DropdownMenuContent align="end" className="min-w-48">
						<DropdownMenuItem onClick={rename}>
							<Pencil aria-hidden size={16} />
							Rename {noun}
						</DropdownMenuItem>
						{archive && (
							<DropdownMenuItem variant="destructive" onClick={archive}>
								<Archive aria-hidden size={16} />
								Archive {noun}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</ChannelConversationActions>
	);
}

/** What a channel's conversation is called in its menu and dialogs. */
function conversationNoun(archivable: boolean): string {
	return archivable ? "thread" : "main chat";
}

/**
 * Renaming a channel's main chat or thread and archiving a thread, which
 * `children` offers as it likes, each opening its own dialog; `archive` is
 * absent for the main chat, which may not be archived.
 */
export function ChannelConversationActions({
	channel,
	conversationId,
	name,
	archivable,
	children,
}: ChannelConversationToChange & {
	children: (open: { rename: () => void; archive?: () => void }) => ReactNode;
}) {
	const rename = useRenameChat(conversationId);
	const archive = useArchiveChat(conversationId);
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const [renaming, setRenaming] = useState(false);
	const [archiving, setArchiving] = useState(false);

	async function archiveAndLeave() {
		try {
			await archive.mutateAsync();
		} catch {
			return;
		}
		setArchiving(false);
		// Back to the channel, or the channel in the archived thread's place, so Back never returns to it.
		leaveForPage(router.buildLocation(channelLink(channel)).href);
	}

	return (
		<>
			{children({
				rename: () => setRenaming(true),
				archive: archivable ? () => setArchiving(true) : undefined,
			})}
			<Dialog open={renaming} onOpenChange={setRenaming}>
				<ChatNameDialog
					title={`Rename ${conversationNoun(archivable)}`}
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
				description="It leaves the channel's list for everyone."
				confirmLabel="Archive"
				pending={archive.isPending}
				error={archive.isError ? "The thread was not archived. Try again." : undefined}
				onDelete={archiveAndLeave}
			/>
		</>
	);
}
