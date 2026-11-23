import type { RunState } from "@sugabots/contracts";

/** How an automation's run stands, as a chat's row says it. */
export type WorkState = "running" | "done" | "failed";

/** How a run stands, from its state: running until it completed, failed or was cancelled. */
export function workStateOf(state: RunState): WorkState {
	if (state === "failed" || state === "cancelled") return "failed";
	if (state === "completed") return "done";
	return "running";
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
