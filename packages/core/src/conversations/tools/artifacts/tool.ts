import {
	ARTIFACT_WRITING_TOOLS,
	type Artifact,
	type ArtifactKind,
	type ArtifactSummary,
	artifactContentSchema,
	artifactKindSchema,
	artifactTitleSchema,
	artifactWrittenSchema,
	type BuiltInToolKey,
	MAX_ARTIFACT_CONTENT_CHARACTERS,
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
type Written = typeof artifactWrittenSchema.Type;

type Refusal = { status: "refused"; reason: string };

/** A change that waits in the document for a person, which the model should report and not retry. */
type Suggested = { status: "suggested"; note: string };

const artifactIdSchema = Schema.String.check(Schema.isUUID()).annotate({
	description: "The artifact's id, from artifact_list or the write that made it",
});
const baseVersionSchema = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	description:
		"The version your change is based on, from artifact_read or your last write. A change based on an older version is refused.",
});

/**
 * The tools an agent uses to keep documents, slide decks and HTML pages in
 * its pod, bound to one turn. Refusals come back as results the model can act
 * on: a stale version tells it to read again, and an edit whose text isn't
 * there once says so.
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
		Effect.map(calls.completedOutputs(turnId, [...ARTIFACT_WRITING_TOOLS]), (outputs) =>
			outputs.some((output) => {
				const written = Schema.decodeUnknownOption(artifactWrittenSchema)(output);
				return (
					Option.isSome(written) &&
					written.value.artifactId === artifactId &&
					written.value.version === version
				);
			}),
		);

	const refusingChanges = <E extends AuthoringFailure>(
		change: Effect.Effect<Artifact, E>,
	): Promise<Written | Refusal | Suggested> =>
		run(
			change.pipe(
				Effect.map(written),
				Effect.catch((failure) => Effect.succeed(refusalFor(failure))),
			),
		);

	return {
		[ARTIFACT_LIST_TOOL]: tool({
			description: "List the documents, slide decks and HTML pages kept in this pod, newest first.",
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
			description: `Write an artifact the pod keeps, for work people will come back to: a plan, report, notes, a slide deck or a page. Without \`artifactId\` it creates one, with \`kind\` and \`title\`. With \`artifactId\` and \`baseVersion\` it replaces that artifact's whole content as a new version; pass them whenever you change an artifact that already exists, rather than making another, and use artifact_edit for a small change. ${KIND_RULES}`,
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
				oldText: Schema.String.check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_ARTIFACT_CONTENT_CHARACTERS),
				),
				newText: Schema.String.check(Schema.isMaxLength(MAX_ARTIFACT_CONTENT_CHARACTERS)),
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
	"A `document` is markdown with `#` headings. A `slides` deck is markdown too, one slide after another, with a line of `---` between each two and a blank line before and after it (without the blank line before, the line above becomes a heading). Start each slide with its layout, as `<!-- layout: bullets -->`. A layout places the slide's boxes in order, and each box after the first starts with `<!-- box -->` on its own line; keep a box's comment even when the box is empty. The layouts are: `title` (the first slide: a `#` heading, then a box with an optional short line under it), `section` (an optional short label such as `Part 2`, then a box with a `##` heading opening a part of the talk), `bullets` (a `##` heading, then a box with a short list), `columns` (a `##` heading, then two boxes side by side, each holding a few lines or a short list), `image` (like `columns`, with the words in the first box after the heading and the last left for an image), `quote` (a `>` quote, then a box with an optional line saying whose it is) or `table` (a `##` heading, then a box with one small table). End a slide with what the speaker says over it, if anything, as `<!-- notes: what to say -->`. Keep each slide to a heading and three to five short points; split anything longer across slides rather than filling one. An `html` page is a complete HTML document, shown in the chat under your reply as well as on its own, so it suits charts, tables and small interactive tools. Make it responsive: it is shown in the chat, opened large beside it and on phones, from about 360px to 1200px wide, so use fluid widths with no fixed or maximum width of its own, let rows wrap or stack when narrow, and size charts and canvases to their container, redrawing when it resizes. It is drawn on the chat's own ground with the app's theme, so it looks part of the conversation: leave the page background transparent, add no outer card or border of your own, and colour it with the app's CSS variables, which follow light and dark mode: --foreground, --body-foreground, --muted-foreground, --subtle-foreground for text; --card, --panel, --chip, --hover for surfaces; --border, --border-strong; --primary, --link, --success-text, --destructive-text, --warning for accents; and --font-sans, --font-mono. It runs in an isolated frame with no network access except scripts from https://cdn.jsdelivr.net (such as Chart.js), so inline its CSS and embed its data.";

/** artifact_write's inputs that don't go together, and what to do instead. */
const WRITE_REFUSALS = {
	newNeedsKindAndTitle: "A new artifact needs a `kind` and a `title`.",
	changeNeedsVersion:
		"Changing an artifact needs the `baseVersion` you read or last wrote. Read it with artifact_read if you don't have it.",
} as const;

const refused = (reason: string): Refusal => ({ status: "refused", reason });

/** Each kind, as a refusal names it. */
const KIND_NAMES: Record<ArtifactKind, string> = {
	document: "a `document`",
	slides: "a `slides` deck",
	html: "an `html` page",
};

/** Why a change to a live document couldn't be made as asked, and what to do instead. */
const SUGGESTION_BLOCKED_REASONS: Record<Artifacts.SuggestionBlocked["blocked"], string> = {
	unmarkable:
		"This change has to be shown as a suggestion, and a suggestion can't be shown inside a code block. Say so, and ask them to change the code block themselves.",
	layoutPending:
		"A new layout suggested for a slide this change touches is waiting for somebody to accept or reject it, and nothing on that slide can change until then, so none of this change was made. Say so, and ask them to settle that suggestion first. The rest of the change can be made again without touching that slide.",
	suggestionPending:
		"A slide whose layout this change sets holds a suggestion waiting for somebody to accept or reject it, and its layout can't change until then, so none of this change was made. Say so, and ask them to settle the suggestions on that slide first. The rest of the change can be made again without changing that slide's layout.",
};

type AuthoringFailure =
	| Artifacts.NotFound
	| Artifacts.Stale
	| Artifacts.KindFixed
	| Artifacts.TooLarge
	| Artifacts.EditTextUnmatched
	| Artifacts.NotWritten;

function refusalFor(failure: AuthoringFailure): Refusal | Suggested {
	switch (failure._tag) {
		case "ArtifactChangeSuggested":
			return {
				status: "suggested",
				note: "This change was asked for from inside the document, so it is shown there as a suggestion and takes effect once somebody accepts it. The document reads as before for now. Say that you suggested it; don't make the change again.",
			};
		case "ArtifactUnreadable":
			return {
				status: "refused",
				reason:
					"This document holds content you can't read from here, so changing it would lose that content. Say so, and leave the document as it is.",
			};
		case "ArtifactSuggestionBlocked":
			return {
				status: "refused",
				reason: SUGGESTION_BLOCKED_REASONS[failure.blocked],
			};
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
				reason: `That artifact is ${KIND_NAMES[failure.kind]} and stays one. Leave out \`artifactId\` to create a new artifact of another kind.`,
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
