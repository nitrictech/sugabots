import type { ChatHistoryEntry, CollaborationPart } from "@sugabots/contracts";

/** How a collaboration or an automation's run stands, as a thread's row or Inbox's line says it. */
export type WorkState = "running" | "done" | "failed";

/** How the collaboration or run a history entry is stands; running until the entry says otherwise. */
export function workStateOf(entry: ChatHistoryEntry | undefined): WorkState {
	if (entry?.status === "failed" || entry?.status === "cancelled") return "failed";
	if (entry?.status === "completed") return "done";
	return "running";
}

/** How a collaboration stands, from the status its part in the asking bot's message carries. */
export function collaborationWorkState(status: CollaborationPart["status"]): WorkState {
	switch (status) {
		case "waiting":
		case "pending":
			return "running";
		case "answered":
			return "done";
		case "failed":
			return "failed";
	}
}

/** A collaboration as the bot that asked tells it: "Growth Desk is talking to Linear Handler". */
export function collaborationText(asker: string, other: string, state: WorkState): string {
	switch (state) {
		case "running":
			return `${asker} is talking to ${other}`;
		case "done":
			return `${asker} collaborated with ${other}`;
		case "failed":
			return `Collaboration with ${other} failed`;
	}
}

/** An automation's run, by the automation's name: "Overnight review ran". */
export function automationText(name: string, state: WorkState): string {
	switch (state) {
		case "running":
			return `${name} is running`;
		case "done":
			return `${name} ran`;
		case "failed":
			return `${name} failed`;
	}
}
