import { type Project, THREAD_NAME_MAX_LENGTH } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { Archive, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useArchiveThread, useRenameThread } from "@/lib/chats.ts";
import { projectLink } from "@/lib/links.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { DropdownMenuItem } from "@/ui/dropdown-menu.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { NameDialog } from "@/ui/name-dialog.tsx";

/** A project's thread as changing it needs it. */
export interface ProjectThreadToChange {
	project: Project;
	conversationId: string;
	name: string;
}

/**
 * Beside a project's thread's name, for whoever may change the project:
 * renaming it, and archiving it, which takes it off the project's list and goes
 * back to the project. A phone has these in the details instead.
 */
export function ProjectThreadMenu(thread: ProjectThreadToChange) {
	return (
		<ProjectThreadActions {...thread}>
			{({ rename, archive }) => (
				<MoreMenu label={`More for ${thread.name}`} variant="bar" className="size-8 max-md:hidden">
					<DropdownMenuItem onClick={rename}>
						<Pencil aria-hidden size={16} />
						Rename thread
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onClick={archive}>
						<Archive aria-hidden size={16} />
						Archive thread
					</DropdownMenuItem>
				</MoreMenu>
			)}
		</ProjectThreadActions>
	);
}

/**
 * Renaming a project's thread and archiving it, which `children` offers as it
 * likes, each opening its own dialog.
 */
export function ProjectThreadActions({
	project,
	conversationId,
	name,
	children,
}: ProjectThreadToChange & {
	children: (open: { rename: () => void; archive: () => void }) => ReactNode;
}) {
	const rename = useRenameThread(conversationId);
	const archive = useArchiveThread(conversationId);
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
		// Back to the project, or the project in the archived thread's place, so Back never returns to it.
		leaveForPage(router.buildLocation(projectLink(project)).href);
	}

	return (
		<>
			{children({
				rename: () => setRenaming(true),
				archive: () => setArchiving(true),
			})}
			<Dialog open={renaming} onOpenChange={setRenaming}>
				<NameDialog
					title="Rename thread"
					name={name}
					maxLength={THREAD_NAME_MAX_LENGTH}
					placeholder="e.g. Pricing"
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
				description="It leaves the project's list for everyone."
				confirmLabel="Archive"
				pending={archive.isPending}
				error={archive.isError ? "The thread was not archived. Try again." : undefined}
				onDelete={archiveAndLeave}
			/>
		</>
	);
}
