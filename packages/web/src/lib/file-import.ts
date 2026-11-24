import { type ArtifactImageType, imageTypeOf, MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";

/*
 * What importing another app's file into a live artifact shares, whatever
 * the file: which of its images the artifact keeps, and how.
 */

/** An image as the artifact keeps it: the kind its bytes are, and the bytes. */
export interface KeepableImage {
	type: ArtifactImageType;
	bytes: Uint8Array;
}

/** Keeps an image for the artifact, answering the address the artifact shows it from. */
export type KeepImage = (image: KeepableImage) => Promise<string>;

/**
 * An image in the file couldn't be kept, as when the API couldn't be reached
 * or refused it, so nothing was imported. `cause` is why.
 */
export class ImageNotKept extends Error {
	constructor(cause: unknown) {
		super("An image in the imported file could not be kept", { cause });
		this.name = "ImageNotKept";
	}
}

/**
 * `bytes`, an image in the file, as the artifact would keep it, as the kind
 * its bytes are, whatever the file says it is, or `undefined` for one it
 * doesn't keep: of a kind it can't show, such as a Windows metafile, or
 * larger than it keeps.
 */
export function keepableImage(bytes: Uint8Array): KeepableImage | undefined {
	if (bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) return undefined;
	const type = imageTypeOf(bytes);
	return type && { type, bytes };
}
