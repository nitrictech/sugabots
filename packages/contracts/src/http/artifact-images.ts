import { ARTIFACT_IMAGE_PATH } from "../artifacts.ts";
import { API_BASE_PATH } from "./api.ts";

/*
 * The address a `document` artifact refers to an image it keeps by: a path on
 * the API's own origin, so the document names no installation. An image's id
 * is the SHA-256 of its bytes, in hex, so the same image kept twice is kept
 * once.
 */

declare const checked: unique symbol;

/** The ids an image kept for a `document` artifact is addressed by, each of the form its address holds. */
export type ArtifactImageIds = {
	readonly podId: string;
	readonly artifactId: string;
	readonly imageId: string;
	readonly [checked]: true;
};

/** `ids`, when each is of the form an image's address holds; `undefined` otherwise. */
export function artifactImageIds(ids: {
	podId: string;
	artifactId: string;
	imageId: string;
}): ArtifactImageIds | undefined {
	const { podId, artifactId, imageId } = ids;
	if (!UUID.test(podId) || !UUID.test(artifactId) || !IMAGE_ID.test(imageId)) return undefined;
	return { podId, artifactId, imageId } as ArtifactImageIds;
}

/** Where the image is served, under the API's base path, as a client on another origin asks for it. */
export const artifactImagePath = ({ podId, artifactId, imageId }: ArtifactImageIds): string =>
	ARTIFACT_IMAGE_PATH.replace(":podId", podId)
		.replace(":artifactId", artifactId)
		.replace(":imageId", imageId);

/** The address a document refers to the image by. */
export const artifactImageAddress = (ids: ArtifactImageIds): string =>
	`${API_BASE_PATH}${artifactImagePath(ids)}`;

/** The image `address` names, when it is the address of an image kept for an artifact. */
export function artifactImageAt(address: string): ArtifactImageIds | undefined {
	const [, podId, artifactId, imageId] = ADDRESS.exec(address) ?? [];
	return podId && artifactId && imageId
		? artifactImageIds({ podId, artifactId, imageId })
		: undefined;
}

/**
 * The image `address` names when it is one `artifact` keeps: a document shows
 * no other image, another document's included, and holds no other in its
 * Word file.
 */
export function ownImageAt(
	address: string,
	artifact: { podId: string; artifactId: string },
): ArtifactImageIds | undefined {
	const ids = artifactImageAt(address);
	return ids?.podId === artifact.podId && ids.artifactId === artifact.artifactId ? ids : undefined;
}

const UUID_FORM = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMAGE_ID_FORM = "[0-9a-f]{64}";

const UUID = new RegExp(`^${UUID_FORM}$`);
const IMAGE_ID = new RegExp(`^${IMAGE_ID_FORM}$`);

const ADDRESS = new RegExp(
	`^${API_BASE_PATH}${ARTIFACT_IMAGE_PATH.replace(":podId", `(${UUID_FORM})`)
		.replace(":artifactId", `(${UUID_FORM})`)
		.replace(":imageId", `(${IMAGE_ID_FORM})`)}$`,
);
