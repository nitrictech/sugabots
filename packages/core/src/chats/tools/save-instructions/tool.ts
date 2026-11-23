import { DESCRIPTION_MAX_LENGTH, PROMPT_MAX_LENGTH } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import { asAsker } from "../../../authorization/current-actor.ts";
import type { RunEffect } from "../../../database/database.ts";
import type { BotAdministration } from "../../../workspaces/bots/bot-administration.ts";

export const SAVE_INSTRUCTIONS_TOOL = "save_instructions";

type SaveInstructionsResult =
	| {
			saved: true;
			/** The bot's settings page, where people read and change what was saved. */
			settingsUrl: string;
	  }
	| { refused: string };

const NOBODY_ASKED =
	"Your instructions are saved only in answer to a person, so nothing was saved.";

const MAY_NOT_EDIT =
	"The person you're answering may not change your settings, so nothing was saved. Someone who can edit you can save them.";

/**
 * The `save_instructions` tool: a bot replaces its own instructions and
 * description, which other bots choose whom to ask by: when it sets itself
 * up in its interview, or when someone asks it to change how it works. It
 * saves as the person it is answering, with their permission to edit the
 * bot, so it is offered on every turn and refused for anyone who could not
 * make the same change in settings.
 */
export function saveInstructionsTool({
	botId,
	askerId,
	bots,
	settingsUrl,
	run,
}: {
	botId: string;
	/** The person whose message the turn answers, or none. */
	askerId: string | null;
	bots: Pick<BotAdministration.Interface, "update">;
	/** The bot's settings page, which shows what it saved. */
	settingsUrl: string;
	run: RunEffect;
}) {
	return tool({
		description:
			"Replace your instructions and description, passing the whole text. Call it when setting yourself up, when someone asks you to change how you work, or when their reply shows you set yourself up for the wrong kind of work: then set yourself up again for the work they meant, and do that work yourself. Not for remembering things about a person. Returns your settings page, where people read and change them.",
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
					"One or two sentences telling the other bots in the workspace what to come to you for.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ instructions, description }): Promise<SaveInstructionsResult> => {
			return run(
				asAsker(
					askerId,
					bots.update({ botId, changes: { prompt: instructions, description } }),
				).pipe(
					Effect.as<SaveInstructionsResult>({ saved: true, settingsUrl }),
					Effect.catchTags({
						NobodyAsked: () => Effect.succeed<SaveInstructionsResult>({ refused: NOBODY_ASKED }),
						ActionForbidden: () =>
							Effect.succeed<SaveInstructionsResult>({ refused: MAY_NOT_EDIT }),
						ResourceHidden: () => Effect.succeed<SaveInstructionsResult>({ refused: MAY_NOT_EDIT }),
					}),
					Effect.orDie,
				),
			);
		},
	});
}
