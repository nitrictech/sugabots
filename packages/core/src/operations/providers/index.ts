/**
 * The providers operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { ModelProviders } from "../../providers/model-providers/model-providers.ts";
import { SearchProviders } from "../../providers/search-providers/search-providers.ts";
import { modelProvidersOperations } from "./model-providers/index.ts";
import { searchProvidersOperations } from "./search-providers/index.ts";

export const providersOperations = {
	...modelProvidersOperations,
	...searchProvidersOperations,
};

export const providersLayer = Layer.mergeAll(ModelProviders.layer, SearchProviders.layer);
