import type { Pod } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { Archive, Ellipsis, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useArchiveChat, useRenameChat } from "@/lib/chats.ts";
import { podLink } from "@/lib/links.ts";
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

/** One of a pod's channels, as changing it needs it. */
export interface ChannelToChange {
	pod: Pod;
	conversationId: string;
	name: string;
	/** Whether it may be archived, which the pod's first may not. */
	archivable: boolean;
}

/**
 * Beside a channel's name, for whoever may change the pod: renaming the
 * channel, and, unless it is the pod's first, archiving it, which takes it off
 * the pod's list and goes back to the pod. Its threads stay where they are.
 * A phone has these in the channel's details instead.
 */
export function ChatMenu(channel: ChannelToChange) {
	return (
		<ChannelActions {...channel}>
			{({ rename, archive }) => (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<IconButton
								label={`More for ${channel.name}`}
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
							Rename channel
						</DropdownMenuItem>
						{archive && (
							<DropdownMenuItem variant="destructive" onClick={archive}>
								<Archive aria-hidden size={16} />
								Archive channel
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</ChannelActions>
	);
}

/**
 * Renaming a channel and archiving it, which `children` offers as it likes,
 * each opening its own dialog; `archive` is absent for a channel that may
 * not be archived.
 */
export function ChannelActions({
	pod,
	conversationId,
	name,
	archivable,
	children,
}: ChannelToChange & {
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
		// Back to Home, or Home in the archived channel's place, so Back never returns to it.
		leaveForPage(router.buildLocation(podLink(pod)).href);
	}

	return (
		<>
			{children({
				rename: () => setRenaming(true),
				archive: archivable ? () => setArchiving(true) : undefined,
			})}
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
