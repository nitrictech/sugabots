import type { WebhookCondition } from "@sugabots/contracts";

/** Whether a webhook call's JSON body `payload` meets every condition of a trigger's `filter`. */
export function meetsFilter(filter: readonly WebhookCondition[] | undefined, payload: unknown) {
	return (filter ?? []).every(({ path, oneOf }) =>
		textsAt(payload, path.split(".")).some((text) => oneOf.includes(text)),
	);
}

function textsAt(value: unknown, keys: readonly string[]): string[] {
	const pending = [{ value, keyIndex: 0 }];
	const texts: string[] = [];
	while (pending.length > 0) {
		const next = pending.pop();
		if (!next) break;
		if (Array.isArray(next.value)) {
			for (const element of next.value) pending.push({ value: element, keyIndex: next.keyIndex });
			continue;
		}
		const key = keys[next.keyIndex];
		if (key === undefined) {
			if (
				typeof next.value === "string" ||
				typeof next.value === "number" ||
				typeof next.value === "boolean"
			)
				texts.push(String(next.value));
			continue;
		}
		if (typeof next.value !== "object" || next.value === null || !Object.hasOwn(next.value, key))
			continue;
		pending.push({ value: Reflect.get(next.value, key), keyIndex: next.keyIndex + 1 });
	}
	return texts;
}
