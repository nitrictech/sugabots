/**
 * The turns operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Turns } from "../../chats/turns/turns.ts";
import { askForApprovals } from "./ask-for-approvals.ts";
import { end } from "./end.ts";
import { endLost } from "./end-lost.ts";
import { finishToolCall } from "./finish-tool-call.ts";
import { load } from "./load.ts";
import { makeModelRequest } from "./make-model-request.ts";
import { planToolCalls } from "./plan-tool-calls.ts";
import { recordToolCall } from "./record-tool-call.ts";
import { recordToolResults } from "./record-tool-results.ts";
import { startApprovedToolCall } from "./start-approved-tool-call.ts";

export const turnsOperations = {
	"turns.load": load,
	"turns.makeModelRequest": makeModelRequest,
	"turns.recordToolCall": recordToolCall,
	"turns.planToolCalls": planToolCalls,
	"turns.finishToolCall": finishToolCall,
	"turns.startApprovedToolCall": startApprovedToolCall,
	"turns.askForApprovals": askForApprovals,
	"turns.recordToolResults": recordToolResults,
	"turns.end": end,
	"turns.endLost": endLost,
};

/** Over the chat services, whose turns these record, and the models they ask. */
export const turnsLayer = Turns.Records.layer;
