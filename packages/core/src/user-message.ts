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

/** `bytes` as people read a file's size, such as 30 MB or 512 KB. */
export function sizeForPeople(bytes: number): { amount: number; unit: "MB" | "KB" } {
	const mebibytes = bytes / (1024 * 1024);
	return mebibytes >= 1
		? { amount: Math.floor(mebibytes), unit: "MB" }
		: { amount: Math.max(1, Math.floor(bytes / 1024)), unit: "KB" };
}
