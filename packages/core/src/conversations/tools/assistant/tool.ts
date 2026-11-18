import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { AssistantGuide } from "../../assistant/assistant-guide.ts";
import type { Request } from "../computer.ts";
import { noInputSchema } from "../no-input.ts";

export const WORKSPACE_GUIDE_TOOL = "workspace_guide";
export const CREATE_CHANNEL_TOOL = "create_channel";
export const JOIN_CHANNEL_TOOL = "join_channel";
export const ADD_BOT_TO_CHANNEL_TOOL = "add_bot_to_channel";
export const PIN_BOT_TOOL = "pin_bot";

/** What the assistant is told of something it did for its person, or why it couldn't. */
type ActedResult = { done: AssistantGuide.Place } | { refused: string };

/**
 * The `workspace_guide` tool, a Personal Assistant's view of its person's
 * workspace: its channels, the bots they can reach with what each has been
 * doing lately, and what is waiting on them.
 */
export function workspaceGuideTool({
	guide,
	person,
	run,
}: {
	guide: Pick<AssistantGuide.Interface, "guide">;
	person: AssistantGuide.Person;
	run: RunEffect;
}) {
	return tool({
		description:
			"See the workspace as your person does: its channels, the bots they can reach with what each is for and what it has been doing lately, and what is waiting on them (approvals, unread mentions, failing automations), each with its link.",
		inputSchema: noInputSchema,
		execute: (): Promise<AssistantGuide.Guide> => run(guide.guide(person)),
	});
}

const nameSchema = (description: string) =>
	Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({ description });

/**
 * The things a Personal Assistant does in the workspace for its person, each
 * of which waits for them to approve it: they change the workspace, or what
 * other people see.
 */
export function assistantRequests({
	guide,
	person,
	run,
}: {
	guide: Omit<AssistantGuide.Interface, "guide">;
	person: AssistantGuide.Person;
	run: RunEffect;
}): Record<string, Request> {
	const acted = (work: Effect.Effect<AssistantGuide.Place, AssistantGuide.Refused>) =>
		run(
			work.pipe(
				Effect.map((done): ActedResult => ({ done })),
				Effect.catch((refusal) => Effect.succeed({ refused: refusal.userMessage })),
			),
		);
	const asked = (made: Request["tool"]): Request => ({ tool: made, refusal: () => undefined });
	return {
		[CREATE_CHANNEL_TOOL]: asked(
			tool({
				description:
					"Make a channel for your person, with them in it. Public channels are listed for anyone in the workspace to join; private ones only for the people added.",
				inputSchema: Schema.Struct({
					name: nameSchema("What the channel is called, like Launch."),
					description: Schema.optional(
						Schema.Trim.check(Schema.isMaxLength(500)).annotate({
							description: "What the channel is for, in a sentence.",
						}),
					),
					private: Schema.optional(
						Schema.Boolean.annotate({ description: "Only people added can find it." }),
					),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (channel): Promise<ActedResult> => acted(guide.createChannel(person, channel)),
			}),
		),
		[JOIN_CHANNEL_TOOL]: asked(
			tool({
				description: "Put your person in a public channel, by its address from workspace_guide.",
				inputSchema: Schema.Struct({
					channel: nameSchema("The channel's address, like launch."),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: ({ channel }): Promise<ActedResult> => acted(guide.joinChannel(person, channel)),
			}),
		),
		[ADD_BOT_TO_CHANNEL_TOOL]: asked(
			tool({
				description:
					"Add a public bot to a channel your person is in, so people there can mention it.",
				inputSchema: Schema.Struct({
					channel: nameSchema("The channel's address, like launch."),
					bot: nameSchema("The bot's handle, like @support."),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (target): Promise<ActedResult> => acted(guide.addBotToChannel(person, target)),
			}),
		),
		[PIN_BOT_TOOL]: asked(
			tool({
				description: "Pin a bot to your person's sidebar, or unpin it.",
				inputSchema: Schema.Struct({
					bot: nameSchema("The bot's handle, like @support."),
					pinned: Schema.Boolean.annotate({ description: "False to unpin it." }),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (target): Promise<ActedResult> => acted(guide.pinBot(person, target)),
			}),
		),
	};
}
