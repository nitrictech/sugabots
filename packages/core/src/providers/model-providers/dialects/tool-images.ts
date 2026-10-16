import type { LanguageModelMiddleware } from "ai";

type Prompt = Parameters<
	NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type PromptMessage = Prompt[number];
type UserContent = Extract<PromptMessage, { role: "user" }>["content"];

/** Where an image a tool returned was, in the result it was moved out of. */
export const IMAGE_MOVED_NOTE = "(The image is in the next message.)";

/**
 * Moves the images in tool results into a message from the user after them,
 * leaving a note where each was. Gemini through OpenRouter refuses a request
 * with an image in a tool result once its reasoning is in the request, saying
 * the request ends with a model turn, but takes the same image from the user.
 * The message starts with text, as one with only an image is refused the same
 * way.
 *
 * Every model through OpenRouter reads an image sent this way, so this keeps
 * working once OpenRouter takes images in Gemini's tool results. It can go
 * then: the test of this in `models.recording.test.ts` shows what is sent, and
 * a Gemini model with reasoning answering a tool result with an image, sent
 * without this, shows whether it is still refused.
 */
export const toolImagesFromUser: LanguageModelMiddleware = {
	transformParams: async ({ params }) => ({
		...params,
		prompt: params.prompt.flatMap(withImagesFromUser),
	}),
};

function withImagesFromUser(message: PromptMessage): PromptMessage[] {
	if (message.role !== "tool") return [message];
	const moved: UserContent = [];
	const content = message.content.map((part) => {
		if (part.type !== "tool-result" || part.output.type !== "content") return part;
		const images = part.output.value.filter(isImage);
		if (images.length === 0) return part;
		moved.push({ type: "text", text: `What ${part.toolName} returned:` }, ...images);
		const value = part.output.value.map((item) =>
			isImage(item) ? { type: "text" as const, text: IMAGE_MOVED_NOTE } : item,
		);
		return { ...part, output: { ...part.output, value } };
	});
	if (moved.length === 0) return [message];
	return [
		{ ...message, content },
		{ role: "user", content: moved },
	];
}

type ToolResultContent = Extract<
	Extract<
		Extract<PromptMessage, { role: "tool" }>["content"][number],
		{ type: "tool-result" }
	>["output"],
	{ type: "content" }
>["value"][number];

function isImage(part: ToolResultContent): part is Extract<ToolResultContent, { type: "file" }> {
	return part.type === "file" && part.mediaType.startsWith("image/");
}
