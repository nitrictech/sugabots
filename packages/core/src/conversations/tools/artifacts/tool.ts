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

/** A change that asked for nothing the artifact keeps, so no version was written. */
type Unchanged = { status: "unchanged"; note: string };

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
	): Promise<Written | Refusal | Suggested | Unchanged> =>
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
						Effect.catchTags({
							ArtifactNotFound: (failure) => Effect.succeed(refusalFor(failure)),
							ArtifactUnreadable: (failure) => Effect.succeed(refusalFor(failure)),
						}),
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
				"Change part of an artifact, as a new version: `oldText` is replaced by `newText`. `oldText` must appear exactly once, so quote enough around the change to make it unique, exactly as it is in the content artifact_read gives. The app keeps what you write in its own form, a deck's HTML most of all, so read the artifact again rather than quote what you wrote.",
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

/** One slide of a deck as its HTML is written, for the model to follow. */
const EXAMPLE_SLIDE = `<section data-slide data-layout="bullets" style="background: #f8fafc">
  <div data-slide-body>
    <div data-slide-box data-role="title" style="left: 80px; top: 64px; width: 800px; height: 48px">
      <h2>Launch goals</h2>
    </div>
    <div data-slide-box data-role="body" style="left: 80px; top: 144px; width: 560px; height: 332px">
      <ul><li><p>Ship on <strong>Friday</strong></p></li><li><p>Tell support first</p></li></ul>
    </div>
    <div data-slide-box data-vertical-align="middle" style="left: 680px; top: 144px; width: 200px; height: 96px; background: #0f766e; padding: 12px 16px">
      <p style="text-align: center"><span style="color: #ffffff; font-size: 28px">On track</span></p>
    </div>
  </div>
  <aside data-speaker-notes>
    <p>Start with the date.</p>
  </aside>
</section>`;

/** The styles a deck keeps, which are all it keeps of CSS. */
const DECK_STYLES = `a slide's \`background\` on its section; a box's \`left\`, \`top\`, \`width\`, \`height\`, \`background\`, \`border\` (as \`2px solid #334155\`), \`padding\` and \`transform: rotate(-5deg)\`, with \`data-vertical-align="middle"\` or \`"bottom"\` to sit its text lower; text's \`color\`, \`font-family\` and \`font-size\` on a \`<span>\`; and \`text-align\` and \`line-height\` on a paragraph or heading. Every length is in px and every colour solid: hex, \`rgb()\` or a name`;

/** How a deck is written, for artifact_write to tell the model. */
const SLIDES_RULES = `A \`slides\` deck is HTML: its slides alone, a \`<section data-slide>\` for each, in order, with no doctype, \`<html>\`, \`<head>\`, \`<body>\`, \`<style>\` or \`<script>\` (those are ignored). A slide is 960 x 540 px. Its boxes go in a \`<div data-slide-body>\`, each a \`<div data-slide-box>\` placed by \`left\`, \`top\`, \`width\` and \`height\` in its \`style\`; later boxes are drawn over earlier ones. A box holds what a document does, as HTML: headings, paragraphs, lists, a small table, a quote, and images as \`<img alt="what it shows" data-address="…">\`; keep an image's \`data-address\` as you read it, as an image from anywhere else shows only its \`alt\`. A shape is an \`<svg viewBox="0 0 W H">\` holding a \`<path>\` with its \`fill\`, \`stroke\` and \`stroke-width\`, first in its box, W and H the box's width and height. \`data-role\` on a box says what it is for, which styles its text: \`title\`, \`subtitle\`, \`body\`, \`leftColumn\`, \`rightColumn\`, \`text\`, \`image\`, \`label\`, \`quote\`, \`attribution\` or \`table\`; leave it out for anything else, such as a shape. A slide's \`data-layout\` is the template it was laid out by, which places these roles: \`title\` (title, subtitle), \`bullets\` (title, body), \`columns\` (title, leftColumn, rightColumn), \`image\` (title, text, image), \`section\` (label, title), \`quote\` (quote, attribution), \`table\` (title, table) or \`blank\` (none). A box with a role and no position goes where its slide's layout puts that role; changing \`data-layout\` alone moves nothing. Style with inline CSS, of which a deck keeps only this, never classes, \`border-radius\`, \`opacity\`, shadows or gradients: ${DECK_STYLES}. A title slide's title is an \`<h1>\`, other slides' an \`<h2>\`. What the speaker says over a slide goes after its body, as paragraphs in an \`<aside data-speaker-notes>\`. For example:\n\n${EXAMPLE_SLIDE}\n\nLay slides out as a designer would: keep text inside its box and every box inside the slide, at least 64 px from its edges; never overlap boxes that hold text; and keep a slide to a heading and three to five short points, splitting anything longer across slides.`;

/** How each kind is written, for artifact_write to tell the model. */
const KIND_RULES = `A \`document\` is markdown with \`#\` headings. ${SLIDES_RULES} An \`html\` page is a complete HTML document, shown in the chat under your reply as well as on its own, so it suits charts, tables and small interactive tools. Make it responsive: it is shown in the chat, opened large beside it and on phones, from about 360px to 1200px wide, so use fluid widths with no fixed or maximum width of its own, let rows wrap or stack when narrow, and size charts and canvases to their container, redrawing when it resizes. It is drawn on the chat's own ground with the app's theme, so it looks part of the conversation: leave the page background transparent, add no outer card or border of your own, and colour it with the app's CSS variables, which follow light and dark mode: --foreground, --body-foreground, --muted-foreground, --subtle-foreground for text; --card, --panel, --chip, --hover for surfaces; --border, --border-strong; --primary, --link, --success-text, --destructive-text, --warning for accents; and --font-sans, --font-mono. It runs in an isolated frame with no network access except scripts from https://cdn.jsdelivr.net (such as Chart.js), so inline its CSS and embed its data.`;

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
};

/** What was wrong with HTML written for a deck that can't be the deck, and what to do instead. */
const DECK_HTML_REFUSALS: Record<Artifacts.DeckHtmlRefused["reason"], string> = {
	saysNothing:
		"That HTML holds no slide, nor anything a slide could, so nothing was changed. Write every slide the deck is to have, each a `<section data-slide>`; a deck always has at least one.",
	nestedTooDeeply:
		"That HTML nests elements far deeper than any slide does, so it can't be read and nothing was changed. Write the slides again as sections, boxes and blocks.",
	wordsLost:
		"Some words in that HTML stand where a slide has no place for them, so they would be lost, and nothing was changed. Put every word in a box's headings, paragraphs, lists, tables or quotes, or in a slide's speaker notes.",
};

/** What a change that asked for nothing an artifact of each kind keeps is told. */
const UNCHANGED_NOTES: Record<ArtifactKind, string> = {
	document:
		"That leaves the document reading as it does already, so nothing was changed and no version was written.",
	slides: `Nothing that changes is something a deck keeps, so the deck is as it was and no version was written. Of CSS a deck keeps only ${DECK_STYLES}. Say so if it matters, rather than writing it again.`,
	html: "That is the page's content already, so nothing was changed and no version was written.",
};

type AuthoringFailure =
	| Artifacts.NotFound
	| Artifacts.Stale
	| Artifacts.KindFixed
	| Artifacts.TooLarge
	| Artifacts.EditTextUnmatched
	| Artifacts.DeckHtmlRefused
	| Artifacts.Unreadable
	| Artifacts.NotWritten;

function refusalFor(failure: AuthoringFailure): Refusal | Suggested | Unchanged {
	switch (failure._tag) {
		case "ArtifactChangeSuggested":
			return {
				status: "suggested",
				note: "This change was asked for from inside the document, so what it changes in words, and any blocks, boxes or slides it adds or removes, are shown there as a suggestion, which takes effect once somebody accepts it; until then the document reads as before. Anything it changed in how a deck looks was made at once. Say that you suggested it; don't make the change again.",
			};
		case "ArtifactUnchanged":
			return { status: "unchanged", note: UNCHANGED_NOTES[failure.kind] };
		case "ArtifactDeckHtmlRefused":
			return { status: "refused", reason: DECK_HTML_REFUSALS[failure.reason] };
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
