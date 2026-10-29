import { type Agent, DESCRIPTION_MAX_LENGTH, PROMPT_MAX_LENGTH } from "@sugabots/contracts";
import { tool } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { AuthenticatedUserId, CurrentActor } from "../../../authorization/current-actor.ts";
import { query, type RunEffect } from "../../../database/database.ts";
import { pod, workspace } from "../../../database/schema.ts";
import type { AgentAdministration } from "../../../workspaces/agents/agent-administration.ts";

export const SAVE_INSTRUCTIONS_TOOL = "save_instructions";

export type SaveInstructionsResult =
	| {
			saved: true;
			/** The agent's settings page, where people read and change what was saved. */
			settingsUrl: string;
	  }
	| { refused: string };

const NOBODY_ASKED =
	"Your instructions are saved only in answer to a person, so nothing was saved.";

const MAY_NOT_EDIT =
	"The person you're answering may not change your settings, so nothing was saved. Someone who can edit you can save them.";

/**
 * The `save_instructions` tool: an agent replaces its own instructions and
 * description, which its pod mates choose whom to ask by: when it sets itself
 * up in its interview, or when someone asks it to change how it works. It
 * saves as the person it is answering, with their permission to edit the
 * agent, so it is offered on every turn and refused for anyone who could not
 * make the same change in settings.
 */
export function saveInstructionsTool({
	agentId,
	askedBy,
	agents,
	webAppUrl,
	run,
}: {
	agentId: string;
	/** The person whose message the turn answers, or none. */
	askedBy: string | null;
	agents: Pick<AgentAdministration.Interface, "update">;
	/** Where the web app is served, without a trailing slash. */
	webAppUrl: string;
	run: RunEffect;
}) {
	return tool({
		description:
			"Replace your instructions and description, passing the whole text. Call it when setting yourself up, or when someone asks you to change how you work. Not for remembering things about a person. Returns your settings page, where people read and change them.",
		inputSchema: Schema.Struct({
			instructions: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(PROMPT_MAX_LENGTH),
			).annotate({
				description: "Your instructions in Markdown, addressed to yourself.",
			}),
			description: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(DESCRIPTION_MAX_LENGTH),
			).annotate({
				description:
					"One or two sentences telling the other bots in your pod what to come to you for.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ instructions, description }): Promise<SaveInstructionsResult> => {
			if (!askedBy) return { refused: NOBODY_ASKED };
			return run(
				agents.update({ agentId, changes: { prompt: instructions, description } }).pipe(
					CurrentActor.provide(AuthenticatedUserId.vouchedFor(askedBy)),
					Effect.andThen((saved) => settingsUrlOf(saved, webAppUrl)),
					Effect.map((settingsUrl): SaveInstructionsResult => ({ saved: true, settingsUrl })),
					Effect.catchTag(["ActionForbidden", "ResourceHidden"], () =>
						Effect.succeed<SaveInstructionsResult>({ refused: MAY_NOT_EDIT }),
					),
					Effect.orDie,
				),
			);
		},
	});
}

/** The address of `saved`'s page in the web app's settings, which shows its instructions. */
const settingsUrlOf = (saved: Agent, webAppUrl: string) =>
	query((db) =>
		db
			.select({ workspaceSlug: workspace.slug, podSlug: pod.slug })
			.from(pod)
			.innerJoin(workspace, eq(workspace.id, pod.workspaceId))
			.where(eq(pod.id, saved.podId))
			.limit(1),
	).pipe(
		Effect.flatMap(([row]) =>
			row
				? Effect.succeed(
						`${webAppUrl}/${row.workspaceSlug}/settings/pods/${row.podSlug}/agents/${saved.handle}`,
					)
				: Effect.die(new Error("A saved agent is not in a pod")),
		),
	);
