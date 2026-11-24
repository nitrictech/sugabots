import { PROJECT_DESCRIPTION_MAX_LENGTH, PROJECT_NAME_MAX_LENGTH } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { AssistantGuide } from "../../assistant/assistant-guide.ts";
import type { Request } from "../computer.ts";
import { noInputSchema } from "../no-input.ts";

export const WORKSPACE_GUIDE_TOOL = "workspace_guide";
export const CREATE_PROJECT_TOOL = "create_project";
export const JOIN_PROJECT_TOOL = "join_project";
export const ADD_BOT_TO_PROJECT_TOOL = "add_bot_to_project";
export const PIN_BOT_TOOL = "pin_bot";

/** What the assistant is told of something it did for its member, or why it couldn't. */
type ActedResult = { done: AssistantGuide.Place } | { refused: string };

/**
 * The `workspace_guide` tool, a Personal Assistant's view of its member's
 * workspace: its projects, the bots they can reach with what each is for,
 * and what is waiting on them.
 */
export function workspaceGuideTool({
	guide,
	member,
	run,
}: {
	guide: Pick<AssistantGuide.Interface, "guide">;
	member: AssistantGuide.Member;
	run: RunEffect;
}) {
	return tool({
		description:
			"See the workspace as your member does: its projects, the bots they can reach with what each is for, and what is waiting on them (approvals, unread mentions, failing automations), each with its link.",
		inputSchema: noInputSchema,
		execute: (): Promise<AssistantGuide.Guide> => run(guide.guide(member)),
	});
}

/** The longest handle or project address the assistant is asked to give. */
const NAME_MAX_LENGTH = 200;

const nameSchema = (description: string, maxLength = NAME_MAX_LENGTH) =>
	Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength)).annotate({
		description,
	});

/**
 * The things a Personal Assistant does in the workspace for its member, each
 * of which waits for them to approve it: they change the workspace, or what
 * other members see.
 */
export function assistantRequests({
	guide,
	member,
	run,
}: {
	guide: Omit<AssistantGuide.Interface, "guide">;
	member: AssistantGuide.Member;
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
		[CREATE_PROJECT_TOOL]: asked(
			tool({
				description:
					"Make a project for your member, with them in it, led by a public bot of their choosing, which answers its chats unless another bot is mentioned. Public projects are listed for anyone in the workspace to join; private ones only for the members added.",
				inputSchema: Schema.Struct({
					name: nameSchema("What the project is called, like Launch.", PROJECT_NAME_MAX_LENGTH),
					lead: nameSchema("The handle of the public bot to lead it, like @support."),
					description: Schema.optional(
						Schema.Trim.check(Schema.isMaxLength(PROJECT_DESCRIPTION_MAX_LENGTH)).annotate({
							description: "What the project is for, in a sentence.",
						}),
					),
					private: Schema.optional(
						Schema.Boolean.annotate({ description: "Only members added can find it." }),
					),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (project): Promise<ActedResult> => acted(guide.createProject(member, project)),
			}),
		),
		[JOIN_PROJECT_TOOL]: asked(
			tool({
				description: "Put your member in a public project, by its address from workspace_guide.",
				inputSchema: Schema.Struct({
					project: nameSchema("The project's address, like launch."),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: ({ project }): Promise<ActedResult> => acted(guide.joinProject(member, project)),
			}),
		),
		[ADD_BOT_TO_PROJECT_TOOL]: asked(
			tool({
				description:
					"Add a public bot to a project your member is in, so members there can mention it.",
				inputSchema: Schema.Struct({
					project: nameSchema("The project's address, like launch."),
					bot: nameSchema("The bot's handle, like @support."),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (target): Promise<ActedResult> => acted(guide.addBotToProject(member, target)),
			}),
		),
		[PIN_BOT_TOOL]: asked(
			tool({
				description: "Pin a bot to your member's sidebar, or unpin it.",
				inputSchema: Schema.Struct({
					bot: nameSchema("The bot's handle, like @support."),
					pinned: Schema.Boolean.annotate({ description: "False to unpin it." }),
				}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
				execute: (target): Promise<ActedResult> => acted(guide.pinBot(member, target)),
			}),
		),
	};
}
