import { validate as isUuid } from "uuid";
import type { AutomationsView } from "@/screens/AutomationsStage.tsx";
import type { Staged } from "@/screens/staged.ts";

export const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

/** What a connectors page's address carries back from an OAuth sign-in. */
interface SignInErrorSearch {
	/** A code saying why the sign-in did not finish, shown only through `signInFailureReason`. */
	oauth_error?: string;
}

export const validateSignInErrorSearch = (search: Record<string, unknown>): SignInErrorSearch => ({
	oauth_error: optionalString(search.oauth_error),
});

interface FileSearch {
	/** An earlier version to show; the current one when absent. */
	version?: number;
}

export const validateFileSearch = (search: Record<string, unknown>): FileSearch =>
	typeof search.version === "number" && Number.isInteger(search.version) && search.version > 0
		? { version: search.version }
		: {};

export interface ChatSearch {
	/** A nested chat, a collaboration or automation run, open beside the chat. */
	nestedChat?: string;
	/** A file open large beside the chat. */
	file?: string;
	/** An earlier version of `file` to show; the current one when absent. */
	version?: number;
	/** The project's computer's desktop open large beside the chat, when no file is. */
	desktop?: true;
	/**
	 * The project's automations open large beside the chat, when nothing
	 * else is: all of them, one by its id, or a new one being made.
	 */
	automations?: string;
	/** A message to jump to in the chat, such as the mention a notification is about. */
	message?: string;
	/** An automation run or collaboration shown as the page itself, in place of the chat. */
	nestedChatPage?: string;
}

export const validateChatSearch = (search: Record<string, unknown>): ChatSearch => {
	const { file } = idParam(search, "file");
	return {
		...idParam(search, "nestedChat"),
		...idParam(search, "message"),
		...idParam(search, "nestedChatPage"),
		...(file
			? { file, ...validateFileSearch(search) }
			: search.desktop === true
				? { desktop: true }
				: typeof search.automations === "string" && isAutomationsView(search.automations)
					? { automations: search.automations }
					: {}),
	};
};

/** How the address says which of a project's automations are open beside its chat. */
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
export const stagedOf = (search: ChatSearch): Staged | undefined =>
	search.file
		? { kind: "file", fileId: search.file, version: search.version }
		: search.desktop
			? { kind: "desktop" }
			: search.automations
				? { kind: "automations", view: automationsViewFromSearch(search.automations) }
				: undefined;

export const stagedSearchOf = (staged: Staged | undefined): ChatSearch => ({
	file: staged?.kind === "file" ? staged.fileId : undefined,
	version: staged?.kind === "file" ? staged.version : undefined,
	desktop: staged?.kind === "desktop" ? true : undefined,
	automations: staged?.kind === "automations" ? automationsViewSearch(staged.view) : undefined,
});

/**
 * `search[name]` when it is an id, and otherwise undefined. Said either way,
 * because the router keeps the address's raw value under any name a route's
 * validation leaves out.
 */
function idParam<Name extends string>(
	search: Record<string, unknown>,
	name: Name,
): { [key in Name]: string | undefined } {
	const value = search[name];
	return { [name]: typeof value === "string" && isUuid(value) ? value : undefined } as {
		[key in Name]: string | undefined;
	};
}
