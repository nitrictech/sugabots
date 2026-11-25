import { Layer } from "effect";
import { SearchProviderStore } from "../../providers/search-providers/search-provider-store.ts";
import { Web } from "../../providers/web/web.ts";
import { fetch } from "./fetch.ts";
import { search } from "./search.ts";

export const webOperations = {
	"web.fetch": fetch,
	"web.search": search,
};

export const webLayer = Layer.merge(Web.layer, SearchProviderStore.layer);
