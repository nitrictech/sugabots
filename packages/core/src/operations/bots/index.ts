/**
 * The bots operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Bots } from "../../workspaces/bots/bots.ts";
import { create } from "./create.ts";
import { ensureAssistant } from "./ensure-assistant.ts";
import { list } from "./list.ts";
import { listSystemBots } from "./list-system-bots.ts";
import { pin } from "./pin.ts";
import { remove } from "./remove.ts";
import { unpin } from "./unpin.ts";
import { update } from "./update.ts";
import { updateSystemBot } from "./update-system-bot.ts";

export const botsOperations = {
	"bots.list": list,
	"bots.create": create,
	"bots.update": update,
	"bots.remove": remove,
	"bots.pin": pin,
	"bots.unpin": unpin,
	"bots.ensureAssistant": ensureAssistant,
	"systemBots.list": listSystemBots,
	"systemBots.update": updateSystemBot,
};

export const botsLayer = Bots.layer;
