import { validate as isUuid } from "uuid";
import type { TasksTab } from "@/lib/links.ts";
import type { AutomationsView } from "@/screens/AutomationsStage.tsx";
import type { Staged } from "@/screens/staged.ts";

/** `?invite=` from the invitations NIT-1758 sent before there was a route. */
export interface RootSearch {
	invite?: string;
}

export const validateInviteSearch = (search: Record<string, unknown>): RootSearch => ({
	invite: typeof search.invite === "string" ? search.invite : undefined,
});

export const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

export interface FileSearch {
	/** An earlier version to show; the current one when absent. */
	version?: number;
}

export const validateFileSearch = (search: Record<string, unknown>): FileSearch =>
	typeof search.version === "number" && Number.isInteger(search.version) && search.version > 0
		? { version: search.version }
		: {};

export interface ConversationSearch {
	/** A collaboration or automation run open beside the chat. */
	item?: string;
	/** A file open large beside the chat, in place of the conversation list. */
	file?: string;
	/** An earlier version of `file` to show; the current one when absent. */
	version?: number;
	/** The bot's computer's desktop open large beside the chat, when no file is. */
	desktop?: true;
	/**
	 * The bot's automations open large beside the chat, when nothing else is: all
	 * of them, one by its id, or a new one being made.
	 */
	automations?: string;
	/** The bot's tasks open large beside the chat, those still going or those done, when nothing else is. */
	tasks?: TasksTab;
	/** A message to jump to in the conversation, such as the mention a notification is about. */
	message?: string;
	/** An automation run or collaboration shown as the page itself, in place of the conversation. */
	itemPage?: string;
}

export const validateConversationSearch = (search: Record<string, unknown>): ConversationSearch => {
	const { file } = idParam(search, "file");
	return {
		...idParam(search, "item"),
		...idParam(search, "message"),
		...idParam(search, "itemPage"),
		...(file
			? { file, ...validateFileSearch(search) }
			: search.desktop === true
				? { desktop: true }
				: typeof search.automations === "string" && isAutomationsView(search.automations)
					? { automations: search.automations }
					: search.tasks === "open" || search.tasks === "done"
						? { tasks: search.tasks }
						: {}),
	};
};

/** How the address says which of a bot's automations are open beside its chat. */
const ALL_AUTOMATIONS = "all";
const NEW_AUTOMATION = "new";

const isAutomationsView = (value: string) =>
	value === ALL_AUTOMATIONS || value === NEW_AUTOMATION || isUuid(value);

const automationsViewFromSearch = (value: string): AutomationsView =>
	value === NEW_AUTOMATION
		? { kind: "new" }
		: value === ALL_AUTOMATIONS
			? { kind: "list" }
			: { kind: "automation", automationId: value };

const automationsViewSearch = (view: AutomationsView): string =>
	view.kind === "new" ? NEW_AUTOMATION : view.kind === "list" ? ALL_AUTOMATIONS : view.automationId;

/** What `search` opens beside a chat, and the search that opens `staged`. */
export const stagedOf = (search: ConversationSearch): Staged | undefined =>
	search.file
		? { kind: "file", fileId: search.file, version: search.version }
		: search.desktop
			? { kind: "desktop" }
			: search.automations
				? { kind: "automations", view: automationsViewFromSearch(search.automations) }
				: search.tasks
					? { kind: "tasks", tab: search.tasks }
					: undefined;

export const stagedSearchOf = (staged: Staged | undefined): ConversationSearch => ({
	file: staged?.kind === "file" ? staged.fileId : undefined,
	version: staged?.kind === "file" ? staged.version : undefined,
	desktop: staged?.kind === "desktop" ? true : undefined,
	automations: staged?.kind === "automations" ? automationsViewSearch(staged.view) : undefined,
	tasks: staged?.kind === "tasks" ? staged.tab : undefined,
});

/**
 * `search[name]` when it is an id, and otherwise undefined. Said either way,
 * because the router keeps the address's raw value under any name a route's
 * validation leaves out.
 */
export function idParam<Name extends string>(
	search: Record<string, unknown>,
	name: Name,
): { [key in Name]: string | undefined } {
	const value = search[name];
	return { [name]: typeof value === "string" && isUuid(value) ? value : undefined } as {
		[key in Name]: string | undefined;
	};
}
