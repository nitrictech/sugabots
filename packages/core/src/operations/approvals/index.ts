/**
 * The approvals operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { decide } from "./decide.ts";

export const approvalsOperations = {
	"approvals.decide": decide,
};

/**
 * Over the chat services, whose turns' calls it decides (see
 * `ChatServices.layer`), and the computers' network, which an allowed host
 * request changes.
 */
export const approvalsLayer = Layer.mergeAll(
	Turns.controlsLayer,
	ComputerNetwork.layer,
	Turns.ApprovalWithdrawals.layer,
);
