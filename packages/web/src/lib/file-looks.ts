import { mediaTypeEssence } from "@sugabots/contracts";

/** How a file is drawn: as its picture, as a page, as a sheet, or as a plain file. */
export type FileLook = "image" | "pdf" | "sheet" | "other";

const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods", "numbers"]);

/**
 * `file`'s look, from its media type and, when that says little, its name.
 * Any image is drawn as its picture, where an image the browser can't draw
 * falls back to a file's icon.
 */
export function fileLookOf(file: { name: string; type: string }): FileLook {
	const mediaType = mediaTypeEssence(file.type);
	if (mediaType.startsWith("image/")) return "image";
	const extension = extensionOf(file.name);
	if (mediaType === "application/pdf" || extension === "pdf") return "pdf";
	if (mediaType === "text/csv" || SHEET_EXTENSIONS.has(extension)) return "sheet";
	return "other";
}

/** The part of `name` after its last dot, lowercased, or "" when it has none. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A file's size as people read it, such as 240 KB or 2.1 MB. */
export function fileSizeLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kilobytes = Math.round(bytes / 1024);
	// Rounded first, so 1,048,100 bytes reads 1.0 MB rather than 1024 KB.
	if (kilobytes < 1024) return `${kilobytes} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
