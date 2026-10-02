const UUID_BYTES = 16;

/** randomUuid returns a random version 4 UUID. */
export function randomUuid(): string {
	// Not `crypto.randomUUID`: browsers leave it undefined on pages served over
	// plain HTTP, while `crypto.getRandomValues` works everywhere.
	const bytes = crypto.getRandomValues(new Uint8Array(UUID_BYTES));
	// RFC 9562: the high nibble of byte 6 is the version, and the top two bits
	// of byte 8 are the variant.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
