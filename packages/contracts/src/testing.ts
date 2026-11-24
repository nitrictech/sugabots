import type { AutomationTrigger } from "./automations.ts";
import { handleFromName } from "./bots.ts";
import type { ListedChat, ProjectChat } from "./chats.ts";
import {
	type Connector,
	type ConnectorToolWithAccess,
	type ConnectorWithTools,
	toolAccessCountsOf,
} from "./connectors.ts";
import type { MemberParticipant } from "./messages.ts";

/**
 * A member as the API shows them, for tests and stories. The handle is derived
 * from the name, as the server derives it; the email is made from the handle
 * unless given; and they have no photo unless given one.
 */
export function testMember({
	id,
	name,
	email,
	image = null,
}: {
	id: string;
	name: string;
	email?: string;
	image?: string | null;
}): MemberParticipant {
	const handle = handleFromName(name);
	return { kind: "member", id, name, email: email ?? `${handle}@example.com`, handle, image };
}

/** A connector for tests and stories, with every tool in full, as the server holds it. */
export type TestConnector = Omit<Connector, "toolCounts"> & { tools: ConnectorToolWithAccess[] };

/** `connector` as its bot's list gives it: how many tools are at each setting, not the tools. */
export function listedConnector({ tools, ...connector }: TestConnector): Connector {
	return { ...connector, toolCounts: toolAccessCountsOf(tools) };
}

/** `connector` as reading it on its own gives it: its tools, without their descriptions. */
export function connectorWithTools(connector: TestConnector): ConnectorWithTools {
	return {
		...listedConnector(connector),
		tools: connector.tools.map(({ description: _, ...tool }) => tool),
	};
}

/** An automation's trigger as a fixture writes it, before it is given an id. */
export type TestAutomationTrigger = AutomationTrigger extends infer T
	? T extends AutomationTrigger
		? Omit<T, "id">
		: never
	: never;

/** An automation's triggers, numbered from `automationId`: the first takes the automation's own id. */
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

/** A project's chat as its list shows it, with nothing new in it unless `standing` says. */
export function listedChat(
	chat: ProjectChat,
	standing: Partial<Omit<ListedChat, "chat">> = {},
): ListedChat {
	return {
		chat,
		lastMessageAt: null,
		participants: [],
		messageCount: 1,
		unreadMessages: 0,
		needsApproval: false,
		mentionsYou: false,
		status: null,
		...standing,
	};
}
