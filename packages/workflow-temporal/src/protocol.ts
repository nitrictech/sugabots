/**
 * The names and messages a Temporal workflow running an Effect workflow body
 * shares with its client and its worker. Adapted from effect-temporal (MIT);
 * see NOTICE.
 */

/** The one Temporal activity type every Effect activity runs through. */
export const activityTypeName = "effect.activity";

/** Signals the client sends a running workflow. */
export const interruptSignalName = "effect.interrupt";
export const resumeSignalName = "effect.resume";
export const completeDeferredSignalName = "effect.complete-deferred";

/** Queries the client asks a running workflow. */
export const stateQueryName = "effect.state";

export type Status = "running" | "suspended" | "completed";

export interface State {
	readonly status: Status;
	/** The encoded `Workflow.Result` of the last pass, while suspended or once completed. */
	readonly result?: unknown;
}

export interface CompleteDeferred {
	readonly name: string;
	/** The encoded `Exit`. */
	readonly exit: unknown;
}

/**
 * Everything the worker needs to rebuild and run one activity: the workflow
 * and its encoded payload identify the activity set, and the activity's full
 * name picks the activity in it (see `Activities.resolve`).
 */
export interface ActivityInput {
	readonly workflow: string;
	readonly activity: string;
	readonly executionId: string;
	readonly payload: unknown;
	readonly attempt: number;
}

/**
 * The Temporal workflow type for an Effect workflow. A worker finds a
 * workflow's function by its export name, so the type must be a valid
 * identifier: export each `makeWorkflow` result under this name.
 */
export const workflowTypeFor = (workflow: string): string =>
	workflow.replace(/[^A-Za-z0-9_$]/g, "_");

/** A Temporal workflow id carries the workflow's name so ids stay readable in Temporal's UI. */
export const workflowIdFor = (workflow: string, executionId: string): string =>
	`${workflow}/${executionId}`;

export const executionIdFrom = (workflowId: string): string =>
	workflowId.slice(workflowId.lastIndexOf("/") + 1);
