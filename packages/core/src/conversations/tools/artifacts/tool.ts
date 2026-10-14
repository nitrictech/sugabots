import {
	type Artifact,
	type ArtifactSummary,
	artifactContentSchema,
	artifactKindSchema,
	artifactTitleSchema,
	type BuiltInToolKey,
} from "@sugabots/contracts";
import { type Tool, tool } from "ai";
import { Effect, Option, Schema } from "effect";
import type { Artifacts } from "../../../artifacts/artifacts.ts";
import type { RunEffect } from "../../../database/database.ts";
import { isUuid } from "../../../ids/ids.ts";
import { noInputSchema } from "../no-input.ts";

export const ARTIFACT_LIST_TOOL = "artifact_list" satisfies BuiltInToolKey;
export const ARTIFACT_READ_TOOL = "artifact_read" satisfies BuiltInToolKey;
export const ARTIFACT_WRITE_TOOL = "artifact_write" satisfies BuiltInToolKey;
export const ARTIFACT_EDIT_TOOL = "artifact_edit" satisfies BuiltInToolKey;

export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
	ARTIFACT_LIST_TOOL,
	ARTIFACT_READ_TOOL,
	ARTIFACT_WRITE_TOOL,
	ARTIFACT_EDIT_TOOL,
]);

/** The artifact tools that change something, for the turn to record as mutating. */
export const MUTATING_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
	ARTIFACT_WRITE_TOOL,
	ARTIFACT_EDIT_TOOL,
]);

export interface ArtifactToolOptions {
	by: Artifacts.AgentInThread;
	/** The turn the tools are bound to, whose writes to one artifact are one version. */
	turnId: string;
	/** The turn's recorded calls: what its completed calls to some tools returned. */
	calls: {
		completedOutputs: (
			turnId: string,
			tools: readonly string[],
		) => Effect.Effect<readonly unknown[]>;
	};
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

/** A write's result as recorded with its call: the parts that say which version it wrote. */
const writtenSchema = Schema.Struct({
	status: Schema.Literal("written"),
	artifactId: Schema.String,
	version: Schema.Int,
});

const artifactIdSchema = Schema.String.annotate({
	description: "The artifact's id, from artifact_list or the write that made it",
});
const baseVersionSchema = Schema.Int.annotate({
	description:
		"The version your change is based on, from artifact_read or your last write. A change based on an older version is refused.",
});

/**
 * The tools an agent uses to keep documents and HTML pages in its pod, bound
 * to one turn. Refusals come back as results the model can act on: a stale
 * version tells it to read again, and an edit whose text isn't there once says so.
 *
 * A reply's writes to one artifact are one version: a change based on a
 * version this turn wrote is written over it, so a reply that edits a page
 * five times leaves one version, not five. Which versions the turn wrote is
 * read from its recorded calls, which outlast a retried or resumed turn.
 */
export function artifactTools({
	by,
	turnId,
	calls,
	authoring,
	run,
}: ArtifactToolOptions): Record<string, Tool> {
	const written = (artifact: Artifact): Written => ({
		status: "written",
		artifactId: artifact.id,
		kind: artifact.kind,
		title: artifact.title,
		version: artifact.version,
	});

	/** Whether this turn wrote `version` of the artifact, and so may write over it. */
	const wroteInTurn = (artifactId: string, version: number) =>
		Effect.map(calls.completedOutputs(turnId, [...MUTATING_ARTIFACT_TOOLS]), (outputs) =>
			outputs.some((output) => {
				const written = Schema.decodeUnknownOption(writtenSchema)(output);
				return (
					Option.isSome(written) &&
					written.value.artifactId === artifactId &&
					written.value.version === version
				);
			}),
		);

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
			inputSchema: noInputSchema,
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

		[ARTIFACT_WRITE_TOOL]: tool({
			description: `Write an artifact the pod keeps, for work people will come back to: a plan, report, notes or a page. Without \`artifactId\` it creates one, with \`kind\` and \`title\`. With \`artifactId\` and \`baseVersion\` it replaces that artifact's whole content as a new version; pass them whenever you change an artifact that already exists, rather than making another, and use artifact_edit for a small change. ${KIND_RULES}`,
			inputSchema: Schema.Struct({
				artifactId: Schema.optional(
					Schema.String.annotate({
						description:
							"Leave out or empty to create a new artifact. To change one, its id from artifact_list or the write that made it",
					}),
				),
				baseVersion: Schema.optional(
					Schema.Int.annotate({
						description:
							"Leave out when creating. When changing, the version your change is based on, from artifact_read or your last write; a change based on an older version is refused",
					}),
				),
				kind: Schema.optional(
					artifactKindSchema.annotate({ description: "Needed when creating; it never changes" }),
				),
				title: Schema.optional(artifactTitleSchema),
				content: artifactContentSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ artifactId, baseVersion, kind, title, content }) => {
				// Some models fill every field, sending "" or "new" for an artifact
				// still to be made. Ids are UUIDs, so anything else names none.
				if (artifactId === undefined || !isUuid(artifactId)) {
					if (kind === undefined || title === undefined)
						return refused(WRITE_REFUSALS.newNeedsKindAndTitle);
					return refusingChanges(authoring.create(by, { kind, title, content }));
				}
				if (baseVersion === undefined) return refused(WRITE_REFUSALS.changeNeedsVersion);
				return refusingChanges(
					Effect.flatMap(wroteInTurn(artifactId, baseVersion), (inPlace) =>
						authoring.replace(by, {
							artifactId,
							baseVersion,
							content,
							inPlace,
							...(title ? { title } : {}),
							...(kind ? { kind } : {}),
						}),
					),
				);
			},
		}),

		[ARTIFACT_EDIT_TOOL]: tool({
			description:
				"Change part of an artifact, as a new version: `oldText` is replaced by `newText`. `oldText` must appear exactly once, so quote enough around the change to make it unique, exactly as it is in the content from artifact_read or your last write.",
			inputSchema: Schema.Struct({
				artifactId: artifactIdSchema,
				baseVersion: baseVersionSchema,
				oldText: Schema.String.check(Schema.isMinLength(1)),
				newText: Schema.String,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: (input) =>
				refusingChanges(
					Effect.flatMap(wroteInTurn(input.artifactId, input.baseVersion), (inPlace) =>
						authoring.edit(by, { ...input, inPlace }),
					),
				),
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

/** How each kind is written, for artifact_write to tell the model. */
const KIND_RULES =
	"A `document` is markdown with `#` headings. An `html` page is a complete HTML document, shown in the chat under your reply as well as on its own, so it suits charts, tables and small interactive tools. Make it responsive: it is shown in the chat, opened large beside it and on phones, from about 360px to 1200px wide, so use fluid widths with no fixed or maximum width of its own, let rows wrap or stack when narrow, and size charts and canvases to their container, redrawing when it resizes. It is drawn on the chat's own ground with the app's theme, so it looks part of the conversation: leave the page background transparent, add no outer card or border of your own, and colour it with the app's CSS variables, which follow light and dark mode: --foreground, --body-foreground, --muted-foreground, --subtle-foreground for text; --card, --panel, --chip, --hover for surfaces; --border, --border-strong; --primary, --link, --success-text, --destructive-text, --warning for accents; and --font-sans, --font-mono. It runs in an isolated frame with no network access except scripts from https://cdn.jsdelivr.net (such as Chart.js), so inline its CSS and embed its data.";

/** artifact_write's inputs that don't go together, and what to do instead. */
const WRITE_REFUSALS = {
	newNeedsKindAndTitle: "A new artifact needs a `kind` and a `title`.",
	changeNeedsVersion:
		"Changing an artifact needs the `baseVersion` you read or last wrote. Read it with artifact_read if you don't have it.",
} as const;

const refused = (reason: string): Refusal => ({ status: "refused", reason });

type AuthoringFailure =
	| Artifacts.NotFound
	| Artifacts.Stale
	| Artifacts.KindFixed
	| Artifacts.TooLarge
	| Artifacts.EditTextUnmatched;

function refusalFor(failure: AuthoringFailure): Refusal {
	switch (failure._tag) {
		case "ArtifactNotFound":
			return { status: "refused", reason: "There is no artifact with that id in this pod." };
		case "ArtifactStale":
			return {
				status: "refused",
				reason: `The artifact is at version ${failure.currentVersion} now. Read it again and base your change on that.`,
			};
		case "ArtifactKindFixed":
			return {
				status: "refused",
				reason: `That artifact is ${failure.kind === "html" ? "an `html` page" : `a \`${failure.kind}\``} and stays one. Leave out \`artifactId\` to create a new artifact of another kind.`,
			};
		case "ArtifactTooLarge":
			return {
				status: "refused",
				reason: `That would make the artifact over ${failure.maxCharacters.toLocaleString("en")} characters, the most it can hold. Make it shorter, or split it into more than one artifact.`,
			};
		case "EditTextUnmatched":
			return {
				status: "refused",
				reason:
					failure.matches === 0
						? "`oldText` isn't in the artifact. Read it again and quote its text exactly."
						: `\`oldText\` appears ${failure.matches} times. Quote more around the change so it appears once.`,
			};
	}
}
