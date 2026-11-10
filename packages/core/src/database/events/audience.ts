export * as Audience from "./audience.ts";

import type { StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace channel. Every member of the
 * workspace listens there, but an event about a thread is only for the people
 * who reach it: those who reach its pod, or, for a direct message between
 * people, those in it. Which rides along in the stored event, under one of
 * the fields below, and the stream reads it and takes it off before delivering.
 */
export type Group =
	| { readonly kind: "pod"; readonly podId: string }
	| { readonly kind: "direct"; readonly threadId: string };

const POD_FIELD = "audiencePodId";
const DIRECT_FIELD = "audienceDirectId";

/** `event`, to be heard only by people who reach the pod `podId`. */
export const forPod = <Event extends StreamEvent>(podId: string, event: Event): Event => ({
	...event,
	[POD_FIELD]: podId,
});

/** `event`, to be heard only by the people in the direct message `threadId`. */
export const forDirectMessage = <Event extends StreamEvent>(
	threadId: string,
	event: Event,
): Event => ({
	...event,
	[DIRECT_FIELD]: threadId,
});

/** Who alone may hear `event`, if it names anybody, and the event as clients see it. */
export function read(event: StreamEvent): {
	readonly audience: Group | undefined;
	readonly event: StreamEvent;
} {
	const { [POD_FIELD]: podId, [DIRECT_FIELD]: threadId, ...delivered } = event;
	const audience: Group | undefined =
		typeof podId === "string"
			? { kind: "pod", podId }
			: typeof threadId === "string"
				? { kind: "direct", threadId }
				: undefined;
	return { audience, event: delivered as StreamEvent };
}
