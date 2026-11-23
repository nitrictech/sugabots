/**
 * The computers operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";

export const computersOperations = {};

export const computersLayer = Layer.empty;
