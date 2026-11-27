import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const listSystemBots = defineOperation(
	botsContracts["systemBots.list"],
	(principal, input) =>
		Effect.gen(function* () {
			const bots = yield* Bots.Service;
			return yield* readingWorkspace(principal, input.workspace, (canRead) =>
				bots.systemBots(canRead),
			);
		}),
);
