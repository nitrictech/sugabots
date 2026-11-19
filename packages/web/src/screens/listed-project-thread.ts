import type { Project } from "@sugabots/contracts";
import { useProjectThreads } from "@/lib/chats.ts";
import type { ProjectThreadToChange } from "./ProjectThreadMenu.tsx";

/**
 * A project's thread as its project lists it: what it is called,
 * and, for whoever may change the project, how to rename or archive it from
 * its menu or its details. An archived thread is not listed, so it goes by
 * `title`, the name it was archived with.
 */
export function useListedProjectThread(
	project: Project | null,
	conversationId: string,
	title: string | undefined,
): { name: string; toChange: ProjectThreadToChange | undefined } {
	const threads = useProjectThreads(project?.id).data?.threads;
	const listed = threads?.find((thread) => thread.conversation.id === conversationId)?.conversation;
	const name = listed?.title ?? title ?? "";
	const toChange =
		listed && project?.permissions.rename ? { project, conversationId, name } : undefined;
	return { name, toChange };
}
