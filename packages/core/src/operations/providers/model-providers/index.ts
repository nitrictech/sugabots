/**
 * The model providers group's operations, by name.
 */

import { addModel } from "./add-model.ts";
import { completeSignIn } from "./complete-sign-in.ts";
import { create } from "./create.ts";
import { discoverModels } from "./discover-models.ts";
import { list } from "./list.ts";
import { listEnabledModels } from "./list-enabled-models.ts";
import { remove } from "./remove.ts";
import { setDefaultModel } from "./set-default-model.ts";
import { signOut } from "./sign-out.ts";
import { startSignIn } from "./start-sign-in.ts";
import { switchOff } from "./switch-off.ts";
import { switchOffModel } from "./switch-off-model.ts";
import { test } from "./test.ts";
import { update } from "./update.ts";
import { updateModel } from "./update-model.ts";

export const modelProvidersOperations = {
	"modelProviders.list": list,
	"modelProviders.listEnabledModels": listEnabledModels,
	"modelProviders.setDefaultModel": setDefaultModel,
	"modelProviders.create": create,
	"modelProviders.update": update,
	"modelProviders.remove": remove,
	"modelProviders.switchOff": switchOff,
	"modelProviders.test": test,
	"modelProviders.startSignIn": startSignIn,
	"modelProviders.completeSignIn": completeSignIn,
	"modelProviders.signOut": signOut,
	"modelProviders.discoverModels": discoverModels,
	"modelProviders.addModel": addModel,
	"modelProviders.updateModel": updateModel,
	"modelProviders.switchOffModel": switchOffModel,
};
