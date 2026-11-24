import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanCreateBots } from "../../proofs/workspace-permissions.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const create = defineOperation(botsContracts["bots.create"], (principal, input) =>
	Effect.gen(function* () {
		const bots = yield* Bots.Service;
		const { workspace: reference, ...bot } = input;
		const workspaceId = yield* workspaceIdOf(reference);
		return yield* named(principal, workspaceId, (principal, workspace) =>
			Effect.gen(function* () {
				const canCreate = yield* proveCanCreateBots(yield* proveInWorkspace(principal, workspace));
				return yield* bots.create(canCreate, bot);
			}),
		);
	}),
);
