import { uuidOrStringSchema, uuidSchema } from "@sugabots/contracts/uuid";
import { type ParsedLocation, redirect } from "@tanstack/react-router";
import { Schema } from "effect";
import type { AutomationsView } from "@/screens/AutomationsStage.tsx";
import type { ChatLogPoint } from "@/screens/chat-log-position.ts";
import type { Staged } from "@/screens/staged.ts";

/** A route parameter naming something by id, with a UUID lowercased as the API returns it. */
export const decodeRouteId = Schema.decodeSync(uuidOrStringSchema);

/** A search parameter naming something by id, if it is a string. */
export const optionalRouteId = (value: unknown) =>
	typeof value === "string" ? decodeRouteId(value) : undefined;

const decodeUuid = Schema.decodeUnknownResult(uuidSchema);

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
	/** An automation's run to jump to in its feed, by the run's chat, as a notification or the sidebar opens it. */
	runChat?: string;
}

export const validateChatSearch = (search: Record<string, unknown>): ChatSearch => {
	const { file } = idParam(search, "file");
	const automations = parseAutomationsView(search.automations);
	return {
		...idParam(search, "message"),
		...idParam(search, "runChat"),
		...(file
			? { file, ...validateFileSearch(search) }
			: search.desktop === true
				? { desktop: true }
				: automations !== undefined
					? { automations }
					: {}),
	};
};

/** Where in the chat its address opens it: at a run, or at a message. */
export const focusOf = (search: ChatSearch): ChatLogPoint | undefined =>
	search.runChat
		? { kind: "run", runChatId: search.runChat }
		: search.message
			? { kind: "message", messageId: search.message }
			: undefined;

export function legacyRunSearch(search: Record<string, unknown>) {
	const { nestedChatPage, ...rest } = search;
	if (typeof nestedChatPage !== "string") return;
	return { ...rest, runChat: decodeRouteId(nestedChatPage) };
}

/**
 * Before a run opened in its feed it opened as a page of its own, named in its
 * feed's address as `?nestedChatPage=`, and emails and push notifications
 * already sent still link that way: such an address goes on, in its place, to
 * the feed with the run named as `?runChat=`.
 */
export function redirectRunPageAddress({ location }: { location: ParsedLocation }): void {
	const search = legacyRunSearch(location.search);
	if (!search) return;
	throw redirect({
		to: location.pathname,
		search,
		hash: location.hash,
		replace: true,
	});
}

/** How the address says which of a project's automations are open beside its chat. */
const ALL_AUTOMATIONS = "all";
const NEW_AUTOMATION = "new";

function parseAutomationsView(value: unknown): string | undefined {
	if (value === ALL_AUTOMATIONS || value === NEW_AUTOMATION) return value;
	const decoded = decodeUuid(value);
	return decoded._tag === "Success" ? decoded.success : undefined;
}

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
	const decoded = decodeUuid(search[name]);
	return { [name]: decoded._tag === "Success" ? decoded.success : undefined } as {
		[key in Name]: string | undefined;
	};
}
