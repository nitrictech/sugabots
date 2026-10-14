import { detectMediaType } from "@ai-sdk/provider-utils";

/**
 * Images the tools show the model: a screenshot, an image in the sandbox, or
 * one a person attached to the thread.
 */

/** An image a tool's result carries for the model to look at. */
export interface Image {
	/** Base 64. */
	data: string;
	mediaType: string;
}

/** The formats shown, as the tools' descriptions name them. */
export const SHOWN_IMAGE_FORMATS = "PNG, JPEG, GIF or WebP";

/**
 * The largest image shown, in bytes: 5 MiB once base 64 encoded, which is how
 * model providers measure the images they accept.
 */
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

/** The media types of the formats shown. Others, such as HEIC or TIFF, models refuse. */
const SHOWN_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The media type `bytes` begin as, when they are an image in a format shown:
 * read from the bytes rather than taken from a name or a declared type, as a
 * provider refuses an image whose declared type its bytes contradict. The AI
 * SDK reads them the same way when it corrects a part's type.
 */
export function shownImageType(bytes: Uint8Array): string | undefined {
	const detected = detectMediaType({ data: bytes, topLevelType: "image" });
	return detected !== undefined && SHOWN_IMAGE_TYPES.has(detected) ? detected : undefined;
}

/** Whether a tool's result carries images for the model. */
export function hasImages(
	output: unknown,
): output is { images: readonly Image[] } & Record<string, unknown> {
	return typeof output === "object" && output !== null && "images" in output;
}

/**
 * A tool's result as the model is given it: one with images as text and
 * images, when the model can take them; anything else as it is.
 */
export function withImages(output: unknown, acceptsImages: boolean) {
	if (!hasImages(output)) {
		return { type: "json" as const, value: output as never };
	}
	const { images, ...rest } = output;
	const text =
		typeof rest.text === "string"
			? [rest.note, rest.text].filter((part) => typeof part === "string").join("\n\n")
			: JSON.stringify(rest);
	if (!acceptsImages) return { type: "text" as const, value: text };
	return {
		type: "content" as const,
		value: [
			{ type: "text" as const, text },
			...images.map((image) => ({
				type: "file" as const,
				data: { type: "data" as const, data: image.data },
				mediaType: image.mediaType,
			})),
		],
	};
}

/**
 * A tool's result as it is kept, with its images counted rather than kept:
 * the model has been shown them, and their data, read back as text in a later
 * turn's history, would be noise.
 */
export function withImagesCounted(output: unknown): unknown {
	if (!hasImages(output)) return output;
	const { images, ...rest } = output;
	return { ...rest, images: `${images.length} shown` };
}
