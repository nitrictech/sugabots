import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { defineOperation } from "../../operation.ts";
import { finishSetupStep } from "./setup-steps.ts";

export const gitHubAppMade = defineOperation(
	connectorsContracts["gitHubConnectors.gitHubAppMade"],
	(principal, input) =>
		finishSetupStep(principal, input.state, "make", (gitHubApps, canManage, setup) =>
			gitHubApps.made(canManage, setup, input.code),
		),
);
