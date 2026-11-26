import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const createAssistant = defineOperation(
	botsContracts["bots.createAssistant"],
	(principal, input) =>
		Effect.gen(function* () {
			const bots = yield* Bots.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const isMember = yield* proveIsMember(principal);
					// Every member's Personal Assistants are theirs to manage, viewers' included.
					const canRead = yield* proveCanReadWorkspace(
						yield* proveInWorkspace(principal, workspace),
					);
					return yield* bots.createAssistant(isMember, canRead);
				}),
			);
		}),
);
