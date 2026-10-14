import { mediaTypeEssence } from "@sugabots/contracts";
import type { ThreadFiles } from "@sugabots/core/conversations/thread-files/thread-files";
import { HttpServerResponse } from "effect/unstable/http";

/**
 * Media types a browser may show in place. Anything else, HTML and SVG
 * included, is offered as a download, so a file someone uploaded can never
 * run as a page of the app.
 */
const SHOWN_IN_PLACE = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
]);

/**
 * A stored file as a response: its own media type, never sniffed for another,
 * shown in place only when it is a common image, and sandboxed should a
 * browser open it anyway. Files never change once kept, so a browser may keep
 * its copy.
 */
export function fileResponse(file: ThreadFiles.StoredFile): HttpServerResponse.HttpServerResponse {
	const shownInPlace = SHOWN_IN_PLACE.has(mediaTypeEssence(file.contentType));
	return HttpServerResponse.stream(file.stream, {
		contentType: file.contentType,
		contentLength: file.size,
		headers: {
			"content-disposition": contentDisposition(shownInPlace ? "inline" : "attachment", file.name),
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox",
			"cache-control": "private, max-age=31536000, immutable",
		},
	});
}

/**
 * RFC 6266: an ASCII `filename` for old browsers, and the exact name, in
 * UTF-8, as `filename*` for the rest.
 */
function contentDisposition(type: "inline" | "attachment", name: string | undefined): string {
	if (name === undefined) return type;
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
