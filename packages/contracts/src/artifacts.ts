import { Schema } from "effect";
import type { BuiltInToolKey } from "./built-in-tools.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const MAX_ARTIFACT_TITLE_CHARACTERS = 200;
export const MAX_ARTIFACT_CONTENT_CHARACTERS = 500_000;

/**
 * What an artifact holds, which decides how it is shown: a `document` is
 * markdown, drawn as text; an `html` page runs in an isolated frame.
 */
export const artifactKindSchema = Schema.Literals(["document", "html"]);
export type ArtifactKind = typeof artifactKindSchema.Type;

export const artifactTitleSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_TITLE_CHARACTERS),
);

export const artifactContentSchema = Schema.String.check(
	Schema.isMaxLength(MAX_ARTIFACT_CONTENT_CHARACTERS),
);

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
