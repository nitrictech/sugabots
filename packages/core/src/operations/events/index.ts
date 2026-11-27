/**
 * The events operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Streams } from "../../streams/streams.ts";
import { followChat } from "./follow-chat.ts";
import { followOwn } from "./follow-own.ts";
import { followWorkspace } from "./follow-workspace.ts";
import { reportTyping } from "./report-typing.ts";

export const eventsOperations = {
	"events.followWorkspace": followWorkspace,
	"events.followChat": followChat,
	"events.followOwn": followOwn,
	"events.reportTyping": reportTyping,
};

export const eventsLayer = Streams.layer;
