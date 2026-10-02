import { DESCRIPTION_MAX_LENGTH, PROMPT_MAX_LENGTH } from "@sugabots/contracts";
import { tool } from "ai";
import { Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { AgentRepository } from "../../../workspaces/agents/agent-repository.ts";

export const SAVE_INSTRUCTIONS_TOOL = "save_instructions";

export type SaveInstructionsResult = { saved: true } | { refused: string };

/**
 * The `save_instructions` tool: an agent still on its interview prompt
 * replaces it with the instructions its creator agreed to, and describes
 * itself for its pod mates, who choose whom to ask by description. Offered only on
 * turns answering that creator, and it saves at most once: after that the
 * agent's prompt is no longer the interview, so it is not offered again.
 */
export function saveInstructionsTool({
	agent,
	agents,
	run,
}: {
	agent: { workspaceId: string; id: string };
	agents: Pick<AgentRepository.Interface, "finishInterview">;
	run: RunEffect;
}) {
	return tool({
		description:
			"Save the instructions and description your creator agreed to as your own, replacing the interview you were created with. Call it once, only after they have said the draft is right.",
		inputSchema: Schema.Struct({
			instructions: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(PROMPT_MAX_LENGTH),
			).annotate({
				description: "Your instructions in Markdown, exactly as agreed, addressed to yourself.",
			}),
			description: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(DESCRIPTION_MAX_LENGTH),
			).annotate({
				description:
					"One or two sentences, exactly as agreed, telling the other bots in your pod what to come to you for.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ instructions, description }): Promise<SaveInstructionsResult> => {
			const saved = await run(
				agents.finishInterview(agent.workspaceId, agent.id, {
					prompt: instructions,
					description,
				}),
			);
			return saved
				? { saved: true }
				: {
						refused:
							"Your instructions were already changed, so nothing was saved. They can be edited in your settings.",
					};
		},
	});
}
