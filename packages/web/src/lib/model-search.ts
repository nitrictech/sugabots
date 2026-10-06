import uFuzzy from "@leeoniya/ufuzzy";
import type { ProviderModel } from "@sugabots/contracts";

/**
 * `IntraMode.SingleError`, written as its value because uFuzzy declares it a `const enum`:
 * each word of a search may be off by one letter, missing, extra, wrong, or swapped with its neighbour.
 */
const matcher = new uFuzzy({ intraMode: 1 });

/** A query's first this-many words are tried in every order; each one more multiplies the work. */
const WORDS_TRIED_IN_ANY_ORDER = 3;

/** The models whose id or display name match `query`'s words in any order, best match first; all of them for an empty query. */
export function searchModels<Model extends Pick<ProviderModel, "modelId" | "displayName">>(
	models: readonly Model[],
	query: string,
): Model[] {
	if (query.trim() === "") return [...models];
	const haystack = models.map(
		(model) => `${model.modelId} ${model.displayName ?? ""} ${withoutSeparators(model.modelId)}`,
	);
	const [matches, info, order] = matcher.search(haystack, query, WORDS_TRIED_IN_ANY_ORDER);
	const ranked = info && order ? order.map((position) => info.idx[position]) : matches;
	return (ranked ?? []).flatMap((index) => models[index as number] ?? []);
}

/** A word that runs an id's parts together, like "gpt4o", matches only the id with its `-` and `.` removed. */
function withoutSeparators(modelId: string): string {
	return modelId.replace(/[^a-z\d]+/gi, "");
}
