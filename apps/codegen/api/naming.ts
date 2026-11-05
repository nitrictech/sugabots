/**
 * Casing the API's names into the names a type, a field or a case is given,
 * and keeping those names apart. Swift and Kotlin case alike, so the model
 * settles every name once, and each emitter spells its own identifiers with them.
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
 * Type names the generated Swift or Kotlin writes without qualifying them, from
 * the language, Foundation, kotlinx.serialization and each app's API support
 * file. A nested type of the same name would hide them from the code around it.
 */
export const reservedTypeNames: ReadonlySet<string> = new Set(
	[
		// Swift and Foundation
		"Any Array Bool Data Date Decoder Dictionary Double Encoder Error Int None Optional Result Set Some String Type URL UUID Void",
		// Kotlin and kotlinx.serialization
		"Boolean Byte ByteArray Char Companion EncodeDefault Float Instant Json JsonElement JsonPrimitive List Long Map Nothing Number Serializable SerialName SerializationException Serializer Short Unit",
		// `APISupport.swift` and `ApiSupport.kt`
		"APIClient AnyCodingKey ApiCaller ApiClient Empty JSONValue Omittable OpenEnum ParameterValue QueryItems",
	]
		.join(" ")
		.split(" "),
);

/**
 * The names of the types nested in one type, which must differ from each other,
 * from the type's own name, from the names of the types it is nested in, and
 * from any name `isReserved` keeps for something a nested type would hide.
 */
export class TypeScope {
	readonly name: string;
	private readonly taken = new Set<string>();
	private readonly isReserved: (name: string) => boolean;

	constructor(name: string, isReserved: (name: string) => boolean) {
		this.name = name;
		this.isReserved = isReserved;
	}

	/**
	 * `wanted` when it's free; otherwise `wanted` and this scope's last word, so
	 * a `Routine` inside `ActivityItem` that would hide the API's own `Routine` is
	 * `RoutineItem`; then that numbered.
	 */
	claim(wanted: string): string {
		const isFree = (name: string) =>
			!this.taken.has(name) && !this.isReserved(name) && name !== this.name;
		const ownerWord = words(this.name).pop() ?? "";
		let name = isFree(wanted) ? wanted : `${wanted}${ownerWord}`;
		for (let attempt = 2; !isFree(name); attempt += 1) name = `${wanted}${ownerWord}${attempt}`;
		this.taken.add(name);
		return name;
	}

	/** The scope of the types nested in `name`, a type nested in this scope. */
	nested(name: string): TypeScope {
		return new TypeScope(
			name,
			(candidate) => this.isReserved(candidate) || candidate === this.name,
		);
	}
}

/**
 * The names of the members of one type, such as a struct's fields or an enum's
 * cases: `wanted` when it's free, otherwise `wanted` numbered.
 */
export class MemberNames {
	private readonly taken = new Set<string>();

	claim(wanted: string): string {
		let name = wanted;
		for (let attempt = 2; this.taken.has(name); attempt += 1) name = `${wanted}${attempt}`;
		this.taken.add(name);
		return name;
	}
}
