import {
	type BuiltInToolKey,
	type FormAnswer,
	type FormRequest,
	formRequestProblems,
	formRequestSchema,
} from "@sugabots/contracts";
import { tool } from "ai";
import { type Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";

export const ASK_FORM_TOOL = "ask_form" satisfies BuiltInToolKey;

/** Someone's answer to a form, and their name, unless they have left since. */
export interface AnsweredForm {
	answer: FormAnswer;
	answeredByName: string | null;
}

/** Where a call reads the answer its form was given: `ToolCallRepository`. */
export interface FormAnswers {
	readonly formAnswer: (call: {
		turnId: string;
		sdkToolCallId: string;
	}) => Effect.Effect<AnsweredForm | undefined>;
}

/**
 * What the model is told a form came to: MCP's elicitation result, and who
 * answered; or, as a failed call, why the form was never shown.
 */
export type AskFormResult =
	| (FormAnswer & { answeredBy: string | null })
	| { status: "failed"; error: string };

const NOBODY_TO_ASK =
	"Nobody is waiting on this reply to fill in a form: it answers a routine or another bot. Ask in your reply instead.";

const NO_ANSWER = "The form's answer could not be read.";

/**
 * The `ask_form` tool: an agent asking the people in its thread to fill in a
 * form, an MCP form-mode elicitation, and waiting for their answer.
 *
 * A call that can be shown is parked like a call awaiting approval (see
 * `turns/turn.steps.ts`): the turn suspends until someone answers or declines,
 * and only then does `execute` run, reading the answer recorded. A call that
 * cannot be shown, because nobody is there to answer it or the form is
 * malformed, runs at once and says why.
 */
export function askFormTool({
	turnId,
	askedBy,
	forms,
	run,
}: {
	turnId: string;
	/** The person whose message the turn answers, or none. */
	askedBy: string | null;
	forms: FormAnswers;
	run: RunEffect;
}) {
	return tool({
		description: DESCRIPTION,
		inputSchema: formRequestSchema.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async (request, { toolCallId }): Promise<AskFormResult> => {
			const notShown = whyNotShown(askedBy, request);
			if (notShown) return { status: "failed", error: notShown };
			const answered = await run(forms.formAnswer({ turnId, sdkToolCallId: toolCallId }));
			if (!answered) return { status: "failed", error: NO_ANSWER };
			return { ...answered.answer, answeredBy: answered.answeredByName };
		},
	});
}

/** Why a call cannot be put to anyone, which then runs at once; none when it waits for an answer. */
export function whyNotShown(askedBy: string | null, request: FormRequest): string | undefined {
	if (!askedBy) return NOBODY_TO_ASK;
	const problems = formRequestProblems(request);
	return problems.length > 0 ? `The form was not shown: ${problems.join(" ")}` : undefined;
}

const DESCRIPTION = `Ask the people in this conversation to fill in a form, and wait for their answer before you carry on. Use it when what you need is easier to give in fields than in a message: choosing between options, filling in several details, or reviewing and editing drafts you prepared. Your reply pauses until someone answers or declines, and the first answer stands. The result is {action: "accept", content} with each answer under its field's name (a field left unanswered is missing), or {action: "decline"}.

The form is an MCP form-mode elicitation. requestedSchema is a flat object, and each of its properties is one of:
- text: {type: "string"}, with optional minLength, maxLength, pattern, and format of "email", "uri", "date" or "date-time"
- a number: {type: "number"} or {type: "integer"}, with optional minimum and maximum
- yes or no: {type: "boolean"}
- one choice: {type: "string", enum: [values]}, or {type: "string", oneOf: [{const: value, title: label}]}
- several choices: {type: "array", items: {type: "string", enum: [values]}} or {type: "array", items: {anyOf: [{const: value, title: label}]}}, with optional minItems and maxItems
Each may have a title, a description and a default, which prefills it. List the fields that must be answered in required. People see the fields in the order you write them.

To have someone review drafts, such as posts to publish, give each draft a boolean field defaulting to true, whether to go ahead with it, followed by a string field defaulting to the draft. Compare the text you get back with your draft to see what they changed.

Never ask for passwords, keys or other secrets.`;
