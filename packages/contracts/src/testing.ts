import { handleFromName } from "./agents.ts";
import {
	type Connection,
	type ConnectionToolWithAccess,
	type ConnectionWithTools,
	toolAccessCountsOf,
} from "./connections.ts";
import type { RoutineTrigger } from "./routines.ts";
import type { PersonParticipant } from "./threads.ts";

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

/** `connection` as the pod's list gives it: how many tools are at each setting, not the tools. */
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

/** A routine's trigger as a fixture writes it, before it is given an id. */
export type TestRoutineTrigger = RoutineTrigger extends infer T
	? T extends RoutineTrigger
		? Omit<T, "id">
		: never
	: never;

/**
 * A routine's triggers, numbered by `routineId`: the first has the routine's
 * own id, as a trigger moved from when routines had one does.
 */
export function routineTriggers(
	routineId: string,
	...triggers: TestRoutineTrigger[]
): RoutineTrigger[] {
	return triggers.map(
		(trigger, index) =>
			({
				...trigger,
				id: index === 0 ? routineId : `${routineId.slice(0, -2)}${String(index).padStart(2, "0")}`,
			}) as RoutineTrigger,
	);
}
