/** The most names written out; the rest are counted as "others". */
const MAX_NAMED = 3;

/** "Jay Yu", "Jay Yu and Priya Kaur", "Jay, Priya and Sam", or "Jay, Priya and 3 others". */
export function listNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length <= MAX_NAMED) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
	const named = names.slice(0, MAX_NAMED - 1);
	return `${named.join(", ")} and ${names.length - named.length} others`;
}
