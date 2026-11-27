import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { defineOperation } from "../../operation.ts";
import { finishSetupStep } from "./setup-steps.ts";

export const gitHubAppInstalled = defineOperation(
	connectorsContracts["gitHubConnectors.gitHubAppInstalled"],
	(principal, input) =>
		finishSetupStep(
			principal,
			input.state,
			"install",
			(gitHubApps, canManage, setup) =>
				gitHubApps.installed(canManage, setup, input.installationId),
			(gitHubApps, setup) => gitHubApps.abandonInstall(setup, input.installationId),
		),
);
