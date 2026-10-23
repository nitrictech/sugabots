import type { WebhookCondition } from "@sugabots/contracts";

/** Whether a webhook call's JSON body `payload` meets every condition of a trigger's `filter`. */
export function meetsFilter(filter: readonly WebhookCondition[] | undefined, payload: unknown) {
	return (filter ?? []).every(({ path, oneOf }) =>
		textsAt(payload, path.split(".")).some((text) => oneOf.includes(text)),
	);
}

/** The texts at `keys` in `value`, searching every element of the arrays on the way. */
function textsAt(value: unknown, keys: readonly string[]): string[] {
	if (Array.isArray(value)) return value.flatMap((element) => textsAt(element, keys));
	const [key, ...rest] = keys;
	if (key === undefined) {
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? [String(value)]
			: [];
	}
	if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return [];
	return textsAt((value as Record<string, unknown>)[key], rest);
}
