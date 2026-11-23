import type { Project } from "@sugabots/contracts";
import { useProjectChats } from "@/lib/chats.ts";
import type { ProjectChatToChange } from "./ProjectChatMenu.tsx";

/**
 * A project's chat as its project lists it: what it is called,
 * and, for whoever may change the project, how to rename it from its menu
 * or its details. Until the list has it, it goes by `title`.
 */
export function useListedProjectChat(
	project: Project | null,
	chatId: string,
	title: string | undefined,
): { name: string; toChange: ProjectChatToChange | undefined } {
	const chats = useProjectChats(project?.id).data?.chats;
	const listed = chats?.find((chat) => chat.chat.id === chatId)?.chat;
	const name = listed?.title ?? title ?? "";
	const toChange = listed && project?.permissions.rename ? { chatId, name } : undefined;
	return { name, toChange };
}
