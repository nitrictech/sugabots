import {
	type Artifact,
	type ArtifactSummary,
	artifactContentSchema,
	artifactKindSchema,
	artifactTitleSchema,
	type BuiltInToolKey,
} from "@sugabots/contracts";
import { type Tool, tool } from "ai";
import { Effect, Schema } from "effect";
import type { Artifacts } from "../../../artifacts/artifacts.ts";
import type { RunEffect } from "../../../database/database.ts";

export const ARTIFACT_LIST_TOOL = "artifact_list" satisfies BuiltInToolKey;
export const ARTIFACT_READ_TOOL = "artifact_read" satisfies BuiltInToolKey;
export const ARTIFACT_CREATE_TOOL = "artifact_create" satisfies BuiltInToolKey;
export const ARTIFACT_REPLACE_TOOL = "artifact_replace" satisfies BuiltInToolKey;
export const DOCUMENT_REPLACE_SECTION_TOOL = "document_replace_section" satisfies BuiltInToolKey;

export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
	ARTIFACT_LIST_TOOL,
	ARTIFACT_READ_TOOL,
	ARTIFACT_CREATE_TOOL,
	ARTIFACT_REPLACE_TOOL,
	DOCUMENT_REPLACE_SECTION_TOOL,
]);

/** The artifact tools that change something, for the turn to record as mutating. */
export const MUTATING_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
	ARTIFACT_CREATE_TOOL,
	ARTIFACT_REPLACE_TOOL,
	DOCUMENT_REPLACE_SECTION_TOOL,
]);

export interface ArtifactToolOptions {
	by: Artifacts.AgentInThread;
	authoring: Artifacts.AuthoringInterface;
	run: RunEffect;
}

/** What the model is told about an artifact it made or changed. */
interface Written {
	status: "written";
	artifactId: string;
	kind: Artifact["kind"];
	title: string;
	version: number;
}

type Refusal = { status: "refused"; reason: string };

const artifactIdSchema = Schema.String.annotate({
	description: "The artifact's id, from artifact_list or artifact_create",
});
const baseVersionSchema = Schema.Int.annotate({
	description:
		"The version your change is based on, from artifact_read or your last write. A change based on an older version is refused.",
});

/**
 * The tools an agent uses to keep documents and HTML pages in its pod, bound
 * to one turn. Refusals come back as results the model can act on: a stale
 * version tells it to read again, a missing heading lists the headings there are.
 */
export function artifactTools({ by, authoring, run }: ArtifactToolOptions): Record<string, Tool> {
	const written = (artifact: Artifact): Written => ({
		status: "written",
		artifactId: artifact.id,
		kind: artifact.kind,
		title: artifact.title,
		version: artifact.version,
	});

	const refusingChanges = <E extends AuthoringFailure>(
		change: Effect.Effect<Artifact, E>,
	): Promise<Written | Refusal> =>
		run(
			change.pipe(
				Effect.map(written),
				Effect.catch((failure) => Effect.succeed(refusalFor(failure))),
			),
		);

	return {
		[ARTIFACT_LIST_TOOL]: tool({
			description: "List the documents and HTML pages kept in this pod, newest first.",
			// An empty Struct converts to "anything but null", which providers refuse as a
			// tool's input; a record of nothing converts to an empty object.
			inputSchema: Schema.Record(Schema.String, Schema.Never).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: async (): Promise<{ artifacts: ArtifactListing[] }> => ({
				artifacts: (await run(authoring.list(by))).map(listing),
			}),
		}),

		[ARTIFACT_READ_TOOL]: tool({
			description: "Read an artifact's current content and version.",
			inputSchema: Schema.Struct({ artifactId: artifactIdSchema }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: ({ artifactId }) =>
				run(
					authoring.read(by, artifactId).pipe(
						Effect.map((artifact) => ({
							status: "found" as const,
							...listing(artifact),
							content: artifact.content,
						})),
						Effect.catchTag("ArtifactNotFound", (failure) => Effect.succeed(refusalFor(failure))),
					),
				),
		}),

		[ARTIFACT_CREATE_TOOL]: tool({
			description:
				"Create an artifact the pod keeps, for work people will come back to: a plan, report, notes or a page. A `document` is markdown with `#` headings. An `html` page is a complete HTML document; it runs in an isolated frame with no network access, so inline its CSS and scripts and embed its data.",
			inputSchema: Schema.Struct({
				kind: artifactKindSchema,
				title: artifactTitleSchema,
				content: artifactContentSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: (input) => refusingChanges(authoring.create(by, input)),
		}),

		[ARTIFACT_REPLACE_TOOL]: tool({
			description:
				"Replace an artifact's whole content, as a new version. For one section of a document, use document_replace_section instead.",
			inputSchema: Schema.Struct({
				artifactId: artifactIdSchema,
				baseVersion: baseVersionSchema,
				content: artifactContentSchema,
				title: Schema.optional(artifactTitleSchema),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: (input) => refusingChanges(authoring.replace(by, input)),
		}),

		[DOCUMENT_REPLACE_SECTION_TOOL]: tool({
			description:
				"Replace one section of a document: from its heading to the next heading at the same level or above. `content` replaces the section, heading line included.",
			inputSchema: Schema.Struct({
				artifactId: artifactIdSchema,
				baseVersion: baseVersionSchema,
				heading: Schema.String.annotate({
					description: "The section's heading text, such as `Goals`",
				}),
				content: artifactContentSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: (input) => refusingChanges(authoring.replaceSection(by, input)),
		}),
	};
}

type ArtifactListing = Pick<ArtifactSummary, "kind" | "title" | "version" | "updatedAt"> & {
	artifactId: string;
};

const listing = (summary: ArtifactSummary): ArtifactListing => ({
	artifactId: summary.id,
	kind: summary.kind,
	title: summary.title,
	version: summary.version,
	updatedAt: summary.updatedAt,
});

type AuthoringFailure =
	| Artifacts.ArtifactNotFound
	| Artifacts.ArtifactStale
	| Artifacts.SectionNotFound
	| Artifacts.NotADocument;

function refusalFor(failure: AuthoringFailure): Refusal {
	switch (failure._tag) {
		case "ArtifactNotFound":
			return { status: "refused", reason: "There is no artifact with that id in this pod." };
		case "ArtifactStale":
			return {
				status: "refused",
				reason: `The artifact is at version ${failure.currentVersion} now. Read it again and base your change on that.`,
			};
		case "SectionNotFound":
			return {
				status: "refused",
				reason: `No single section has that heading. The document's headings are: ${failure.headings.join(", ") || "none"}.`,
			};
		case "NotADocument":
			return {
				status: "refused",
				reason: "Only documents have sections. Use artifact_replace for an HTML page.",
			};
	}
}
