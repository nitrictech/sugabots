export * as PodAudience from "./pod-audience.ts";

import type { StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace channel. Every member of the
 * workspace listens there, but an event about a thread is only for people
 * who reach its pod, so the pod rides along in the stored event, under
 * `FIELD`, and the stream reads it and takes it off before delivering.
 */
const FIELD = "audiencePodId";

/** `event`, to be heard only by people who reach the pod `podId`. */
export const forPod = <Event extends StreamEvent>(podId: string, event: Event): Event => ({
	...event,
	[FIELD]: podId,
});

/** The pod whose people alone may hear `event`, if it names one, and the event as clients see it. */
export function audienceOf(event: StreamEvent): {
	readonly podId: string | undefined;
	readonly event: StreamEvent;
} {
	const { [FIELD]: podId, ...delivered } = event;
	return { podId: typeof podId === "string" ? podId : undefined, event: delivered as StreamEvent };
}
