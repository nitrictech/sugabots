import { DESCRIPTION_MAX_LENGTH, PROMPT_MAX_LENGTH } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import { AuthenticatedUserId, CurrentActor } from "../../../authorization/current-actor.ts";
import type { RunEffect } from "../../../database/database.ts";
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
	settingsUrl,
	run,
}: {
	agentId: string;
	/** The person whose message the turn answers, or none. */
	askedBy: string | null;
	agents: Pick<AgentAdministration.Interface, "update">;
	/** The agent's settings page, which shows what it saved. */
	settingsUrl: string;
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
					Effect.as<SaveInstructionsResult>({ saved: true, settingsUrl }),
					CurrentActor.provide(AuthenticatedUserId.vouchedFor(askedBy)),
					Effect.catchTag(["ActionForbidden", "ResourceHidden"], () =>
						Effect.succeed<SaveInstructionsResult>({ refused: MAY_NOT_EDIT }),
					),
					Effect.orDie,
				),
			);
		},
	});
}
