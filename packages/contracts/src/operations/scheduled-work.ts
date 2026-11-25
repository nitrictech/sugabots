import { Schema } from "effect";
import { acceptedRunSchema } from "../automations.ts";
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import { ResourceHidden } from "../errors/proofs.ts";
import { uuidSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

export const scheduledWorkContracts = {
	"approvals.expire": OperationContract.make("approvals.expire", {
		description: "Withdraw an undecided approval once its lifetime ends.",
		input: Schema.Struct({ approvalId: Schema.String }),
		output: Schema.Void,
		errors: [ResourceHidden],
		changes: true,
	}),
	"deletions.finish": OperationContract.make("deletions.finish", {
		description: "Destroy remaining computers and finish a recorded deletion.",
		input: Schema.Struct({ id: uuidSchema }),
		output: Schema.Void,
		errors: [ResourceHidden, ComputerUnavailable, ComputerMadeMeanwhile, ClaimLost],
		changes: true,
	}),
	"automations.runDueRoutine": OperationContract.make("automations.runDueRoutine", {
		description: "Accept a run for a due routine and set when the routine next falls due.",
		input: Schema.Struct({ triggerId: uuidSchema }),
		output: Schema.UndefinedOr(
			Schema.Union([acceptedRunSchema, Schema.Literals(["skipped", "retry"])]),
		),
		errors: [ResourceHidden],
		changes: true,
	}),
	"automations.pauseAfterFailures": OperationContract.make("automations.pauseAfterFailures", {
		description: "Apply a pending pause recorded after consecutive automation failures.",
		input: Schema.Struct({ automationId: uuidSchema }),
		output: Schema.Void,
		errors: [ResourceHidden],
		changes: true,
	}),
	"projectComputer.sleepIfIdle": OperationContract.make("projectComputer.sleepIfIdle", {
		description: "Put the named computer to sleep if it is still idle.",
		input: Schema.Struct({ computerId: uuidSchema }),
		output: Schema.Void,
		errors: [ResourceHidden, ClaimLost, ComputerUnavailable],
		changes: true,
	}),
	"gitHubConnectors.uninstall": OperationContract.make("gitHubConnectors.uninstall", {
		description: "Attempt a queued GitHub app uninstall when it falls due.",
		input: Schema.Struct({ uninstallId: uuidSchema }),
		output: Schema.Void,
		errors: [ResourceHidden],
		changes: true,
	}),
};

const schedulerOnly = {
	http: { kind: "heldBack", reason: "The scheduler starts it from stored work." },
	botLoop: { kind: "heldBack", reason: "The scheduler starts it from stored work." },
} as const;

export const scheduledWorkExposure = {
	"deletions.finish": schedulerOnly,
	"approvals.expire": schedulerOnly,
	"automations.runDueRoutine": schedulerOnly,
	"automations.pauseAfterFailures": schedulerOnly,
	"projectComputer.sleepIfIdle": schedulerOnly,
	"gitHubConnectors.uninstall": schedulerOnly,
} satisfies DomainExposure<typeof scheduledWorkContracts>;
