import type { AutomationTrigger } from "./automations.ts";
import { handleFromName } from "./bots.ts";
import type { ListedThread, ProjectThread } from "./chats.ts";
import {
	type Connection,
	type ConnectionToolWithAccess,
	type ConnectionWithTools,
	toolAccessCountsOf,
} from "./connections.ts";
import type { PersonParticipant } from "./conversations.ts";

/**
 * A person as the API shows them, for tests and stories. The handle is derived
 * from the name, as the server derives it; the email is made from the handle
 * unless given; and they have no photo unless given one.
 */
export function testPerson({
	id,
	name,
	email,
	image = null,
}: {
	id: string;
	name: string;
	email?: string;
	image?: string | null;
}): PersonParticipant {
	const handle = handleFromName(name);
	return { kind: "person", id, name, email: email ?? `${handle}@example.com`, handle, image };
}

/** A connection for tests and stories, with every tool in full, as the server holds it. */
export type TestConnection = Omit<Connection, "toolCounts"> & { tools: ConnectionToolWithAccess[] };

/** `connection` as its bot's list gives it: how many tools are at each setting, not the tools. */
export function listedConnection({ tools, ...connection }: TestConnection): Connection {
	return { ...connection, toolCounts: toolAccessCountsOf(tools) };
}

/** `connection` as reading it on its own gives it: its tools, without their descriptions. */
export function connectionWithTools(connection: TestConnection): ConnectionWithTools {
	return {
		...listedConnection(connection),
		tools: connection.tools.map(({ description: _, ...tool }) => tool),
	};
}

/** An automation's trigger as a fixture writes it, before it is given an id. */
export type TestAutomationTrigger = AutomationTrigger extends infer T
	? T extends AutomationTrigger
		? Omit<T, "id">
		: never
	: never;

/**
 * An automation's triggers, numbered by `automationId`: the first has the automation's
 * own id, as a trigger moved from when automations had one does.
 */
export function automationTriggers(
	automationId: string,
	...triggers: TestAutomationTrigger[]
): AutomationTrigger[] {
	return triggers.map(
		(trigger, index) =>
			({
				...trigger,
				id:
					index === 0
						? automationId
						: `${automationId.slice(0, -2)}${String(index).padStart(2, "0")}`,
			}) as AutomationTrigger,
	);
}

/** A project's thread as its list shows it, with nothing new in it unless `standing` says. */
export function listedThread(
	thread: ProjectThread,
	standing: Partial<Omit<ListedThread, "conversation">> = {},
): ListedThread {
	return {
		conversation: thread,
		lastMessage: null,
		participants: [],
		messageCount: 1,
		unreadMessages: 0,
		needsApproval: false,
		mentionsYou: false,
		activity: null,
		...standing,
	};
}
