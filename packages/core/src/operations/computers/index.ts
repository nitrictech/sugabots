/**
 * The computers operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { ComputerProviderSetup } from "../../computers/computer-provider-setup.ts";
import { ProjectComputerSetup } from "../../computers/project-computer-setup.ts";
import { addProjectHost } from "./add-project-host.ts";
import { addWorkspaceHost } from "./add-workspace-host.ts";
import { blockHost } from "./block-host.ts";
import { computerAccess } from "./computer-access.ts";
import { computerDisks } from "./computer-disks.ts";
import { createProvider } from "./create-provider.ts";
import { listProviders } from "./list-providers.ts";
import { prepareProviderTemplate } from "./prepare-provider-template.ts";
import { projectComputer } from "./project-computer.ts";
import { projectNetwork } from "./project-network.ts";
import { providerTemplate } from "./provider-template.ts";
import { removeProjectHost } from "./remove-project-host.ts";
import { removeProvider } from "./remove-provider.ts";
import { removeWorkspaceHost } from "./remove-workspace-host.ts";
import { resetComputer } from "./reset-computer.ts";
import { testProvider } from "./test-provider.ts";
import { unblockHost } from "./unblock-host.ts";
import { updateProvider } from "./update-provider.ts";
import { upgradeComputer } from "./upgrade-computer.ts";
import { workspaceNetwork } from "./workspace-network.ts";

export const computersOperations = {
	"computerProviders.list": listProviders,
	"computerProviders.access": computerAccess,
	"computerProviders.create": createProvider,
	"computerProviders.update": updateProvider,
	"computerProviders.remove": removeProvider,
	"computerProviders.template": providerTemplate,
	"computerProviders.prepareTemplate": prepareProviderTemplate,
	"computerProviders.test": testProvider,
	"computerProviders.disks": computerDisks,
	"computerProviders.network": workspaceNetwork,
	"computerProviders.addHost": addWorkspaceHost,
	"computerProviders.removeHost": removeWorkspaceHost,
	"computerProviders.blockHost": blockHost,
	"computerProviders.unblockHost": unblockHost,
	"projectComputer.get": projectComputer,
	"projectComputer.reset": resetComputer,
	"projectComputer.upgrade": upgradeComputer,
	"projectComputer.network": projectNetwork,
	"projectComputer.addHost": addProjectHost,
	"projectComputer.removeHost": removeProjectHost,
};

export const computersLayer = Layer.mergeAll(
	ComputerProviderSetup.layer,
	ComputerNetwork.layer,
	ProjectComputerSetup.layer,
);
