import { type ReachChange, streamEvent, workspaceStream } from "@sugabots/contracts";
import { Audience } from "../database/events/audience.ts";
import type { PendingEvent } from "../database/events/outbox.ts";

/**
 * The event that records a change of who reaches `about` in the workspace
 * `workspaceId`, to publish in the transaction that made it. Every stream and
 * desktop viewer open in the workspace proves again on it; it is sent to
 * those who reach what it is about once it has (see `Audience.ofReachChange`).
 */
export const reachChanged = (workspaceId: string, about: ReachChange): PendingEvent => ({
	stream: workspaceStream(workspaceId),
	event: Audience.addressedTo(
		Audience.ofReachChange(about),
		streamEvent("reach.changed", { about }),
	),
});

/**
 * The event that records a change to who reaches a bot that may leave some
 * members out, as making it private or taking a member out of it does. Sent
 * to everyone in the workspace, so those who no longer reach it hear it too
 * and drop it from what they see, and so it names no bot: a private bot's id
 * is for those who reach it.
 */
export const botReachNarrowed = (workspaceId: string): PendingEvent =>
	reachChanged(workspaceId, { kind: "workspace" });
