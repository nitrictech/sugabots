/**
 * The automations operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { ProjectAutomations } from "../../chats/automations/project-automations.ts";
import { addTrigger } from "./add-trigger.ts";
import { create } from "./create.ts";
import { getSecret } from "./get-secret.ts";
import { createWithRoutine, listInChat, updateInChat } from "./in-chat.ts";
import { list } from "./list.ts";
import { projectRuns } from "./project-runs.ts";
import { remove } from "./remove.ts";
import { removeTrigger } from "./remove-trigger.ts";
import { rotateSecret } from "./rotate-secret.ts";
import { run } from "./run.ts";
import { update } from "./update.ts";
import { updateTrigger } from "./update-trigger.ts";
import { webhook } from "./webhook.ts";

export const automationsOperations = {
	"automations.list": list,
	"automations.create": create,
	"automations.update": update,
	"automations.listInChat": listInChat,
	"automations.createWithRoutine": createWithRoutine,
	"automations.updateInChat": updateInChat,
	"automations.remove": remove,
	"automations.run": run,
	"automations.addTrigger": addTrigger,
	"automations.updateTrigger": updateTrigger,
	"automations.removeTrigger": removeTrigger,
	"automations.getSecret": getSecret,
	"automations.rotateSecret": rotateSecret,
	"automations.projectRuns": projectRuns,
	"automations.webhook": webhook,
};

/**
 * Over the chat services' `ChatEvents`, which carries what accepting a run
 * posts, and `AutomationRuns`, which starts runs' workflows: the entrypoint
 * provides both, as it composes the chat services.
 */
export const automationsLayer = ProjectAutomations.layer;
