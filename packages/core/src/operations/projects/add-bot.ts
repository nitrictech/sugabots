import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import {
	checkProjectMembershipChange,
	proveCanChangeProjectMembers,
} from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject, type ReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation, unexpectedApprovalProof } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const addBot = defineOperation(
	projectsContracts["projects.addBot"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* named(
				input.projectId,
				input.botId,
				call,
				input,
				(project, bot, call, approvedInput) => {
					const approveAddition = <P, J>(reach: ReachesProject<P, J>) =>
						Effect.gen(function* () {
							const { principal } = reach;
							const reachesBot = yield* proveReachesBot(principal, bot);
							if (call.value.kind === "approvalCheck")
								yield* projects.checkBotAddition(reach, reachesBot);
							const approved = yield* proveApproved(
								principal,
								call,
								approvalRule("projects.addBot"),
								approvedInput,
								project,
								bot,
							);
							return { reachesBot, approved };
						});

					if (call.value.kind === "approvalCheck") {
						return named(principal, (principal) =>
							proveReachesProject(principal, project).pipe(
								Effect.tap(checkProjectMembershipChange),
								Effect.flatMap(approveAddition),
								Effect.andThen(unexpectedApprovalProof),
							),
						);
					}
					return underProjectsLock(principal, input.projectId, (lock) =>
						Effect.gen(function* () {
							const canChange = yield* proveCanChangeProjectMembers(
								lock,
								yield* proveReachesProject(lock.principal, project),
							);
							const { reachesBot, approved } = yield* approveAddition(canChange.reach);
							return yield* projects.addBot(lock, canChange, reachesBot, approved);
						}),
					);
				},
			);
		}),
);
