import type { UserText } from "@sugabots/errors";

/**
 * A failure that people may be told about. `message` is for the logs and may
 * quote anything, a provider's response included; `userMessage` is the only
 * part people see.
 */
export interface UserFacing {
	readonly message: string;
	readonly userMessage: UserText;
}
