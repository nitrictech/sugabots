import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { Membership } from "../../workspaces/membership/membership.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const memberships = defineOperation(
	workspaceContracts["workspaces.memberships"],
	(principal, input) =>
		Effect.gen(function* () {
			const membership = yield* Membership.Service;
			return yield* readingWorkspace(principal, input.workspace, membership.memberships);
		}),
);
