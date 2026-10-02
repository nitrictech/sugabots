import { handleFromName } from "./agents.ts";
import type { PersonParticipant } from "./threads.ts";

/**
 * A person as the API shows them, for tests and stories. The handle is derived
 * from the name, as the server derives it, and they have no photo unless given
 * one.
 */
export function testPerson({
	id,
	name,
	image = null,
}: {
	id: string;
	name: string;
	image?: string | null;
}): PersonParticipant {
	return { kind: "person", id, name, handle: handleFromName(name), image };
}
