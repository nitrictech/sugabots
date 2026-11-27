import { CHAT_NAME_MAX_LENGTH } from "@sugabots/contracts";
import { Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useRenameChat } from "@/lib/chats.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { DropdownMenuItem } from "@/ui/dropdown-menu.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { NameDialog } from "@/ui/name-dialog.tsx";

/** A project's chat as renaming it needs it. */
export interface ProjectChatToChange {
	chatId: string;
	name: string;
}

/**
 * Beside a project's chat's name, for whoever may change the project:
 * renaming it. A phone has this in the details instead.
 */
export function ProjectChatMenu(chat: ProjectChatToChange) {
	return (
		<ProjectChatActions {...chat}>
			{({ rename }) => (
				<MoreMenu label={`More for ${chat.name}`} variant="bar" className="size-8 max-md:hidden">
					<DropdownMenuItem onClick={rename}>
						<Pencil aria-hidden size={16} />
						Rename chat
					</DropdownMenuItem>
				</MoreMenu>
			)}
		</ProjectChatActions>
	);
}

/** Renaming a project's chat, which `children` offers as it likes, in a dialog of its own. */
export function ProjectChatActions({
	chatId,
	name,
	children,
}: ProjectChatToChange & {
	children: (open: { rename: () => void }) => ReactNode;
}) {
	const rename = useRenameChat(chatId);
	const [renaming, setRenaming] = useState(false);
	return (
		<>
			{children({ rename: () => setRenaming(true) })}
			<Dialog open={renaming} onOpenChange={setRenaming}>
				<NameDialog
					title="Rename chat"
					name={name}
					maxLength={CHAT_NAME_MAX_LENGTH}
					placeholder="e.g. Pricing"
					onSave={async (renamed) => {
						await rename.mutateAsync(renamed);
						setRenaming(false);
					}}
				/>
			</Dialog>
		</>
	);
}
