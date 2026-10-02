import { handleFromName } from "./agents.ts";
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
