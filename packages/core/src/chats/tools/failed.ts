import type { UserText } from "@sugabots/errors";

/** What the bot is told when a tool couldn't do its work. */
export interface Failed {
	readonly status: "failed";
	readonly error: UserText;
}

export const failed = (error: UserText): Failed => ({ status: "failed", error });
