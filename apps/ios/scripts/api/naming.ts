/**
 * Casing the API's names into the names a type, a field or a case is given.
 * Swift and Kotlin case alike, so the model names inline types with these, and
 * each emitter spells its own identifiers with them.
 */

export function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

export function pascalCase(text: string): string {
	const result = words(text)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
	return /^[0-9]/.test(result) ? `_${result}` : result;
}

export function camelCase(text: string): string {
	const pascal = pascalCase(text);
	if (pascal.startsWith("_")) return pascal;
	// `URLs` → `urls`, `ID` → `id`, `HTTPHeader` → `httpHeader`.
	const leadingCapitals = pascal.match(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)/)?.[0];
	if (leadingCapitals) return leadingCapitals.toLowerCase() + pascal.slice(leadingCapitals.length);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** What one item of a list called `name` is called: `threads` → `thread`. */
export function singular(name: string): string {
	if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
	if (/(ss|us|is)$/.test(name)) return `${name}Item`;
	if (/s$/.test(name)) return name.slice(0, -1);
	return `${name}Item`;
}

/**
 * The names given to the types nested in one type, which must differ from each
 * other, from the type's own name, and from any name `isReserved` keeps for
 * something the nested type would hide.
 */
export class NestedNames {
	private readonly taken = new Set<string>();
	private readonly ownerName: string;
	private readonly isReserved: (name: string) => boolean;

	constructor(ownerName: string, isReserved: (name: string) => boolean) {
		this.ownerName = ownerName;
		this.isReserved = isReserved;
	}

	/**
	 * `wanted` when it's free; otherwise `wanted` and the owner's last word, so a
	 * `Routine` inside `ActivityItem` that would hide the API's own `Routine` is
	 * `RoutineItem`; then that numbered.
	 */
	claim(wanted: string): string {
		const isFree = (name: string) =>
			!this.taken.has(name) && !this.isReserved(name) && name !== this.ownerName;
		const ownerWord = words(this.ownerName).pop() ?? "";
		let name = isFree(wanted) ? wanted : `${wanted}${ownerWord}`;
		for (let attempt = 2; !isFree(name); attempt += 1) name = `${wanted}${ownerWord}${attempt}`;
		this.taken.add(name);
		return name;
	}

	has(name: string): boolean {
		return this.taken.has(name);
	}
}
