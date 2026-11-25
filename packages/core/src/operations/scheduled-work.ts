import { scheduledWorkContracts as contracts } from "@sugabots/contracts/operations/scheduled-work";
import { Effect, Layer } from "effect";
import { AutomationRunner } from "../chats/automations/automation-runner.ts";
import { AutomationStore } from "../chats/automations/store.ts";
import { Turns } from "../chats/turns/turns.ts";
import { ProjectComputers } from "../computers/project-computers.ts";
import { proveDoesStoredWork } from "../proofs/does-stored-work.ts";
import { named } from "../proofs/proof.ts";
import { GitHubUninstalls } from "../providers/connectors/github/uninstalls.ts";
import { finishDeletion } from "./finish-deletion.ts";
import { defineOperation } from "./operation.ts";

export const scheduledWorkOperations = {
	"approvals.expire": defineOperation(contracts["approvals.expire"], (principal, { approvalId }) =>
		named(principal, approvalId, (principal, approval) =>
			Effect.gen(function* () {
				const proof = yield* proveDoesStoredWork(principal, approval, "approvalExpiry");
				const withdrawals = yield* Turns.ApprovalWithdrawals.Service;
				yield* withdrawals.expire(proof);
			}),
		),
	),
	"deletions.finish": defineOperation(contracts["deletions.finish"], (caller, { id }) =>
		named(caller, id, (principal, target) =>
			Effect.gen(function* () {
				const { workspace, work, id } = yield* proveDoesStoredWork(principal, target, "deletion");
				yield* finishDeletion(caller, workspace, { kind: work.targetKind, id: id.value });
			}),
		),
	),
	"automations.runDueRoutine": defineOperation(
		contracts["automations.runDueRoutine"],
		(principal, { triggerId }) =>
			named(principal, triggerId, (principal, trigger) =>
				Effect.gen(function* () {
					const proof = yield* proveDoesStoredWork(principal, trigger, "dueRoutine");
					const runner = yield* AutomationRunner.Service;
					return yield* runner.runDueRoutine(proof);
				}),
			),
	),
	"automations.pauseAfterFailures": defineOperation(
		contracts["automations.pauseAfterFailures"],
		(principal, { automationId }) =>
			named(principal, automationId, (principal, automation) =>
				Effect.gen(function* () {
					const proof = yield* proveDoesStoredWork(principal, automation, "pauseAfterFailures");
					const store = yield* AutomationStore.Service;
					yield* store.pauseAfterFailures(proof);
				}),
			),
	),
	"projectComputer.sleepIfIdle": defineOperation(
		contracts["projectComputer.sleepIfIdle"],
		(principal, { computerId }) =>
			named(principal, computerId, (principal, computer) =>
				Effect.gen(function* () {
					const proof = yield* proveDoesStoredWork(principal, computer, "computerSleep");
					const computers = yield* ProjectComputers.Service;
					yield* computers.sleepIfIdle(proof);
				}),
			),
	),
	"gitHubConnectors.uninstall": defineOperation(
		contracts["gitHubConnectors.uninstall"],
		(principal, { uninstallId }) =>
			named(principal, uninstallId, (principal, uninstall) =>
				Effect.gen(function* () {
					const proof = yield* proveDoesStoredWork(principal, uninstall, "gitHubUninstall");
					const uninstalls = yield* GitHubUninstalls.Service;
					yield* uninstalls.uninstall(proof);
				}),
			),
	),
};

export const scheduledWorkLayer = Layer.mergeAll(
	AutomationStore.layer,
	ProjectComputers.layer,
	GitHubUninstalls.layer,
);
