import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const ensureAssistant = defineOperation(
	botsContracts["bots.ensureAssistant"],
	(principal, input) =>
		Effect.gen(function* () {
			const bots = yield* Bots.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const canRead = yield* proveCanReadWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return yield* bots.ensureAssistant(yield* proveIsMember(principal), canRead, input.model);
				}),
			);
		}),
);
