import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { Bots } from "../../workspaces/bots/bots.ts";
import { defineOperation } from "../operation.ts";
import { managingWorkspace } from "../workspace-openings.ts";

export const updateSystemBot = defineOperation(
	botsContracts["systemBots.update"],
	(principal, input) =>
		Effect.gen(function* () {
			const bots = yield* Bots.Service;
			return yield* managingWorkspace(principal, input.workspace, (canManage) =>
				bots.setSystemBotModel(canManage, input.key, input.model),
			);
		}),
);
