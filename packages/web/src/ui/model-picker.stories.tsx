import { useState } from "react";
import { expect, fn, screen, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { ModelPicker } from "./model-picker.tsx";

const models = [
	{
		providerId: "0199a3a0-0000-7000-8000-0000000000c1",
		providerName: "Anthropic",
		providerPreset: "anthropic" as const,
		providerActive: true,
		modelId: "claude-opus-4-1-20250805",
		displayName: null,
	},
	{
		providerId: "0199a3a0-0000-7000-8000-0000000000c1",
		providerName: "Anthropic",
		providerPreset: "anthropic" as const,
		providerActive: true,
		modelId: "claude-sonnet-4-20250514",
		displayName: null,
	},
	{
		providerId: "0199a3a0-0000-7000-8000-0000000000c2",
		providerName: "OpenAI",
		providerPreset: "openai" as const,
		providerActive: true,
		modelId: "gpt-5",
		displayName: null,
	},
];

const meta = preview.meta({
	title: "Controls/ModelPicker",
	component: ModelPicker,
	tags: ["ai-generated"],
	args: { models, value: models[0]?.modelId ?? "", onValueChange: fn() },
	decorators: [
		(Story) => (
			<div className="w-[420px] p-4">
				<Story />
			</div>
		),
	],
});

/** The provider is part of the choice: the same identifier is served by several. */
export const Chosen = meta.story({});

/** Nothing picked yet, as the new agent form opens before the models arrive. */
export const Empty = meta.story({ args: { value: "" } });

/**
 * An agent pinned to a model the workspace no longer offers still says what it
 * is on — the value stays at the head of the list rather than showing blank.
 */
export const ModelNoLongerOffered = meta.story({
	args: { value: "gpt-4o-mini-2024-07-18" },
});

/** While the models are still loading there is nothing to choose between. */
export const Loading = meta.story({ args: { models: [], value: "", disabled: true } });

/** Typing filters the list, which is the point of it over a plain select. */
export const FiltersAsYouType = meta.story({
	render: (args) => {
		const [value, setValue] = useState("");
		return <ModelPicker {...args} value={value} onValueChange={setValue} />;
	},
	play: async ({ canvas }) => {
		await userEvent.type(canvas.getByRole("combobox"), "sonnet");

		// The list is portalled out of the canvas, so it is found on the document.
		const options = await screen.findAllByRole("option");
		await expect(options).toHaveLength(1);
		await expect(options[0]).toHaveTextContent("claude-sonnet-4-20250514");
	},
});
