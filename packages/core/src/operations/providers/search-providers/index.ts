/**
 * The search providers group's operations, by name.
 */

import { get } from "./get.ts";
import { remove } from "./remove.ts";
import { replace } from "./replace.ts";
import { test } from "./test.ts";
import { update } from "./update.ts";
import { webAccess } from "./web-access.ts";

export const searchProvidersOperations = {
	"searchProviders.get": get,
	"searchProviders.webAccess": webAccess,
	"searchProviders.replace": replace,
	"searchProviders.update": update,
	"searchProviders.remove": remove,
	"searchProviders.test": test,
};
