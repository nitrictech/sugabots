/**
 * JSON cut off part way, read as if it had been closed there: an open string
 * ends where it stops, and an unfinished key or value is dropped.
 */
export function parsePartialJson(text: string): unknown {
	let end = text.length;
	while (end > 0) {
		const closed = closedJson(text.slice(0, end));
		if (closed !== undefined) {
			try {
				return JSON.parse(closed);
			} catch {}
		}
		// Back to the last element boundary, always moving.
		end = Math.min(
			end - 1,
			Math.max(
				text.lastIndexOf(",", end - 1),
				text.lastIndexOf("{", end - 1) + 1,
				text.lastIndexOf("[", end - 1) + 1,
			),
		);
	}
	return undefined;
}

/** `prefix` with its open string, objects and arrays closed, or undefined if it can't be. */
function closedJson(prefix: string): string | undefined {
	const open: string[] = [];
	let inString = false;
	let escaped = false;
	for (const char of prefix) {
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") open.push("}");
		else if (char === "[") open.push("]");
		else if (char === "}" || char === "]") open.pop();
	}
	let body = prefix;
	if (inString) body = `${escaped ? body.slice(0, -1) : body}"`;
	body = body.replace(/[,:\s]+$/, "");
	if (body === "") return undefined;
	return body + open.reverse().join("");
}
