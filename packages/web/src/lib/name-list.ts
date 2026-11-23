/**
 * "Jay Yu", "Jay Yu and Priya Kaur", "Jay, Priya and Sam", or "Jay, Priya and 3 others":
 * at most `maxNamed` names written out, the rest counted as "others".
 */
export function listNames(names: readonly string[], { maxNamed = 3 } = {}): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length <= maxNamed) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
	const named = names.slice(0, maxNamed - 1);
	return `${named.join(", ")} and ${names.length - named.length} others`;
}

/** `text` with its first letter a capital: "used it" reads "Used it". */
export function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `count` with the word for one or for several: "1 reply", "3 replies". */
export function countOf(count: number, one: string, several: string): string {
	return `${count} ${count === 1 ? one : several}`;
}
