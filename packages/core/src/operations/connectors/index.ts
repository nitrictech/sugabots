/**
 * The connectors operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { Connectors } from "../../providers/connectors/connectors.ts";
import { GitHubApps } from "../../providers/connectors/github/github-app.ts";
import { GitHubConnectors } from "../../providers/connectors/github/github-connectors.ts";
import { connectBuiltIn } from "./connect-built-in.ts";
import { create } from "./create.ts";
import { get } from "./get.ts";
import { addRepository } from "./github/add-repository.ts";
import { delivery } from "./github/delivery.ts";
import { gitHubAppInstalled } from "./github/github-app-installed.ts";
import { gitHubAppMade } from "./github/github-app-made.ts";
import { installUrl } from "./github/install-url.ts";
import { reachableRepositories } from "./github/reachable-repositories.ts";
import { removeRepository } from "./github/remove-repository.ts";
import { repositories } from "./github/repositories.ts";
import { start } from "./github/start.ts";
import { list } from "./list.ts";
import { oauthCallback } from "./oauth-callback.ts";
import { remove } from "./remove.ts";
import { startOAuth } from "./start-oauth.ts";
import { test } from "./test.ts";
import { testUnsaved } from "./test-unsaved.ts";
import { update } from "./update.ts";

export const connectorsOperations = {
	"connectors.list": list,
	"connectors.create": create,
	"connectors.testUnsaved": testUnsaved,
	"connectors.get": get,
	"connectors.update": update,
	"connectors.remove": remove,
	"connectors.test": test,
	"connectors.connectBuiltIn": connectBuiltIn,
	"connectors.startOAuth": startOAuth,
	"connectors.oauthCallback": oauthCallback,
	"gitHubConnectors.start": start,
	"gitHubConnectors.installUrl": installUrl,
	"gitHubConnectors.reachableRepositories": reachableRepositories,
	"gitHubConnectors.repositories": repositories,
	"gitHubConnectors.addRepository": addRepository,
	"gitHubConnectors.removeRepository": removeRepository,
	"gitHubConnectors.gitHubAppMade": gitHubAppMade,
	"gitHubConnectors.gitHubAppInstalled": gitHubAppInstalled,
	"gitHubWebhooks.delivery": delivery,
};

export const connectorsLayer = Layer.mergeAll(
	Connectors.layer,
	GitHubApps.layer,
	GitHubConnectors.layer,
);
