/**
 * The bot loop: the entrypoint bots work through. It runs a turn as a durable
 * workflow, one step at a time, authenticating the turn's principal each time
 * the turn starts or resumes, and records everything through its own
 * operations, called for that principal.
 *
 * Core starts turns without knowing the bot loop: it declares the services
 * that start and signal turns, and the server provides them from here.
 */
export * as BotLoop from "./bot-loop.ts";

import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { Layer } from "effect";
import * as Requests from "./requests.ts";
import * as Signals from "./signals.ts";
import * as Steps from "./steps.ts";
import { Turn, turnWorkflow } from "./turn.workflow.ts";

/** The bot loop's workflows' definitions, which lanes are made for. */
export const definitions = [Turn] as const;

/**
 * Core's `TurnRequests` and `TurnSignals`, which start the turn workflow in
 * its lane and signal it. Over the lanes and the workflow engine.
 */
export const edgeLayer = Layer.mergeAll(Requests.layer, Signals.layer);

/**
 * The turn workflow, run by the engine over its steps. Over the operation
 * registry, which the steps record through, and the chat services and tools
 * the turns' records and tools are built from.
 */
export const layer = turnWorkflow.layer.pipe(
	Layer.provide(Steps.layer),
	Layer.provide(Layer.mergeAll(Turns.Runs.layer, Turns.Tools.layer, TurnAuthentication.layer)),
);
