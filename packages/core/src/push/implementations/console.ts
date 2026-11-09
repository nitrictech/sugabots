import { Effect } from "effect";
import type { Push } from "../push.ts";

/** Prints each push instead of sending it, for development without a service's key. */
export const fromConsole: Push.Sender<"apns"> & Push.Sender<"fcm"> = {
	send: (device: Push.DeviceOf<"apns" | "fcm">, notification) =>
		Effect.sync(() =>
			console.log(
				`push to ${device.service} ${device.token.slice(0, 8)}…: ${notification.title}\n${notification.body}`,
			),
		),
	check: () => Effect.void,
};
