import { Schema } from "effect";
import type { BuiltInToolKey } from "./built-in-tools.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_ARTIFACT_TITLE_CHARACTERS = 200;
export const MAX_ARTIFACT_CONTENT_CHARACTERS = 500_000;

/**
 * What an artifact holds, which decides how it is shown: a `document` is
 * markdown, drawn as text; a `slides` deck is markdown too, slide after slide,
 * each laid out by one of a few layouts (see `slides-markdown.ts`); an `html`
 * page runs in an isolated frame.
 */
export const artifactKindSchema = Schema.Literals(["document", "slides", "html"]);
export type ArtifactKind = typeof artifactKindSchema.Type;

/**
 * The kinds people edit together, live, in one copy that bots change too
 * (see `live-document.ts`). Each holds images of its own.
 */
const LIVE_ARTIFACT_KINDS = ["document", "slides"] as const satisfies readonly ArtifactKind[];
export type LiveArtifactKind = (typeof LIVE_ARTIFACT_KINDS)[number];

/** Whether `artifact` is of a kind people edit live. */
export const isEditedLive = <A extends { readonly kind: ArtifactKind }>(
	artifact: A,
): artifact is A & { readonly kind: LiveArtifactKind } =>
	(LIVE_ARTIFACT_KINDS as readonly ArtifactKind[]).includes(artifact.kind);

/**
 * What an editor joining a live artifact's WebSocket says it was built for,
 * as the query of the address it opens: the number of the schema it holds
 * (`LIVE_DOCUMENT_SCHEMA` in `live-document.ts`) and the kind of artifact
 * whose nodes it holds. The sync layer deletes, for everyone, whatever an
 * editor's schema cannot hold, so the API lets in only an editor built for
 * the artifact's own.
 */
export const liveEditorQuerySchema = Schema.Struct({
	schema: Schema.FiniteFromString.check(Schema.isInt()),
	kind: Schema.Literals(LIVE_ARTIFACT_KINDS),
});

/**
 * The code the API closes a live artifact's WebSocket with when the editor
 * that opened it was built for another schema or kind than the artifact's
 * (see `liveEditorQuerySchema`): HTTP's Conflict, among the codes WebSocket
 * leaves to applications. A browser can't read why an upgrade was refused,
 * nor tell a refusal from the API being down, but it can read this, so the
 * editor stops and asks to be reloaded instead of connecting again.
 */
export const LIVE_EDITOR_REFUSED_CLOSE_CODE = 4409;

export const artifactTitleSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_TITLE_CHARACTERS),
);

export const artifactContentSchema = Schema.String.check(
	Schema.isMaxLength(MAX_ARTIFACT_CONTENT_CHARACTERS),
);

/**
 * The kinds of image a document or deck keeps to show in it: those every
 * browser draws, and none that can carry script, as SVG can.
 */
export const artifactImageTypeSchema = Schema.Literals([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
export type ArtifactImageType = typeof artifactImageTypeSchema.Type;

/**
 * Which of the kinds a document keeps `bytes` are an image of, told by the
 * signature each kind's files start with, or `undefined` when they start as
 * none of them. What a file is called or said to be doesn't change what its
 * bytes are, and a browser draws an image by its bytes.
 */
export function imageTypeOf(bytes: Uint8Array): ArtifactImageType | undefined {
	return IMAGE_SIGNATURES.find(({ parts }) =>
		parts.every(({ at, signature }) =>
			signature.every((byte, index) => bytes[at + index] === byte),
		),
	)?.type;
}

/**
 * The bytes each kind of image starts with, at their offsets. WebP's come in
 * two parts, as its container writes the file's size between them.
 */
const IMAGE_SIGNATURES: readonly {
	type: ArtifactImageType;
	parts: readonly { at: number; signature: readonly number[] }[];
}[] = [
	{ type: "image/png", parts: [{ at: 0, signature: [0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a] }] },
	{ type: "image/jpeg", parts: [{ at: 0, signature: [0xff, 0xd8, 0xff] }] },
	{ type: "image/gif", parts: [{ at: 0, signature: ascii("GIF87a") }] },
	{ type: "image/gif", parts: [{ at: 0, signature: ascii("GIF89a") }] },
	{
		type: "image/webp",
		parts: [
			{ at: 0, signature: ascii("RIFF") },
			{ at: 8, signature: ascii("WEBP") },
		],
	},
];

function ascii(text: string): number[] {
	return [...text].map((character) => character.charCodeAt(0));
}

/** The largest image a document or deck keeps, in bytes. */
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;

/** The most a document or deck keeps of images in all, in bytes. */
export const MAX_ARTIFACT_IMAGES_BYTES = 50 * 1024 * 1024;

/**
 * Where an image a document or deck keeps is served, under the API's base
 * path: the artifacts group's `image` endpoint, and the address the document
 * refers to the image by (see `http/artifact-images.ts`).
 */
export const ARTIFACT_IMAGE_PATH = "/pods/:podId/artifacts/:artifactId/images/:imageId";

/** Who wrote a version: an agent, or nobody known any more. */
export const artifactAuthorSchema = Schema.NullOr(
	Schema.Struct({ agentId: uuidSchema, name: Schema.String }),
);
export type ArtifactAuthor = typeof artifactAuthorSchema.Type;

export const artifactSummarySchema = Schema.Struct({
	id: uuidSchema,
	podId: uuidSchema,
	kind: artifactKindSchema,
	title: Schema.String,
	/** The number of the current version, counting from 1. */
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	createdBy: artifactAuthorSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});
export type ArtifactSummary = typeof artifactSummarySchema.Type;

export const artifactVersionSummarySchema = Schema.Struct({
	number: Schema.Int.check(Schema.isGreaterThan(0)),
	author: artifactAuthorSchema,
	createdAt: isoTimestampSchema,
});
export type ArtifactVersionSummary = typeof artifactVersionSummarySchema.Type;

/** An artifact as of one version, with that version's content. */
export const artifactSchema = Schema.Struct({
	...artifactSummarySchema.fields,
	content: Schema.String,
	shownVersion: artifactVersionSummarySchema,
});
export type Artifact = typeof artifactSchema.Type;

/** The tools whose completed calls write an artifact, returning what `artifactWrittenSchema` reads. */
export const ARTIFACT_WRITING_TOOLS: ReadonlySet<string> = new Set([
	"artifact_write",
	"artifact_edit",
] satisfies BuiltInToolKey[]);

/**
 * What a call to one of `ARTIFACT_WRITING_TOOLS` returns when it writes: the
 * artifact, at the version it wrote. The model is told this, and it is
 * recorded as the call's output.
 */
export const artifactWrittenSchema = Schema.Struct({
	status: Schema.Literal("written"),
	artifactId: uuidSchema,
	kind: artifactKindSchema,
	title: Schema.String,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
});
