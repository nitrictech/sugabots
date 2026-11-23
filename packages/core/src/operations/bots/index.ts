/**
 * The bots operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";

export const botsOperations = {};

export const botsLayer = Layer.empty;
