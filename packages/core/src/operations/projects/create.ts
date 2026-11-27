import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import type { Principal } from "../../principal.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { type Named, named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { proveCanCreateProjects } from "../../proofs/workspace-permissions.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation, unexpectedApprovalProof } from "../operation.ts";

/**
 * Making a project puts its creator, the workspace's owner and admins and its
 * lead in it, so it is proved and made under the workspace's lock, with the
 * lead named afresh there.
 */
export const create = defineOperation(
	projectsContracts["projects.create"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(input.leadBotId, call, input, (leadBot, call, approvedInput) => {
				const proveCreation = <P, W>(principal: Named<P, Principal>, workspace: Named<W, string>) =>
					Effect.gen(function* () {
						const canCreate = yield* proveCanCreateProjects(
							yield* proveInWorkspace(principal, workspace),
						);
						const lead = yield* proveReachesBot(principal, leadBot);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("projects.create"),
							approvedInput,
							workspace,
							leadBot,
						);
						return { canCreate, lead, approved };
					});

				if (call.value.kind === "approvalCheck") {
					return named(principal, workspaceId, (principal, workspace) =>
						proveCreation(principal, workspace).pipe(Effect.andThen(unexpectedApprovalProof)),
					);
				}
				return underWorkspaceLock(principal, workspaceId, (lock) =>
					Effect.gen(function* () {
						const { canCreate, lead, approved } = yield* proveCreation(
							lock.principal,
							lock.workspace,
						);
						return yield* projects.create(lock, canCreate, lead, approved);
					}),
				);
			});
		}),
);
