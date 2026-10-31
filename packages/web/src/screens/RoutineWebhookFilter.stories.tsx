import { MAX_WEBHOOK_FILTER_CONDITIONS, MAX_WEBHOOK_FILTER_VALUES } from "@sugabots/contracts";
import { type ComponentProps, useState } from "react";
import { expect, fn, mocked, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { FilterGroup } from "./RoutineWebhookFilter.tsx";

function FilterExample({ filter: initial, onChange }: ComponentProps<typeof FilterGroup>) {
	const [filter, setFilter] = useState(initial);
	return (
		<div className="max-w-lg bg-background p-4">
			<FilterGroup
				filter={filter}
				onChange={async (next) => {
					await onChange(next);
					setFilter(next);
				}}
			/>
		</div>
	);
}

const meta = preview.meta({
	title: "Product/WebhookFilter",
	component: FilterGroup,
	tags: ["ai-generated"],
	args: { filter: [], onChange: fn(async () => undefined) },
	render: (args) => <FilterExample {...args} />,
});

/** Each value is preserved exactly, including commas, empty strings, whitespace and line breaks. */
export const ExactValues = meta.story({
	args: { filter: [{ path: "data.name", oneOf: ["north, south", "", " padded ", "line\nbreak"] }] },
	play: async ({ canvas, userEvent, args }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Edit condition 1" }));
		for (const [index, value] of ["north, south", "", " padded ", "line\nbreak"].entries())
			await expect(canvas.getByLabelText(`Accepted value ${index + 1}`)).toHaveValue(value);
		await userEvent.clear(canvas.getByLabelText("JSON path"));
		await userEvent.type(canvas.getByLabelText("JSON path"), "data.title");
		await userEvent.click(canvas.getByRole("button", { name: "Save condition" }));
		await expect(args.onChange).toHaveBeenCalledWith([
			{ path: "data.title", oneOf: ["north, south", "", " padded ", "line\nbreak"] },
		]);
		await expect(canvas.getByText("data.title")).toBeVisible();
	},
});

/** A failed save keeps the draft available for a retry. */
export const FailedSave = meta.story({
	beforeEach({ args }) {
		mocked(args.onChange)
			.mockReset()
			.mockRejectedValueOnce(new Error("Save failed"))
			.mockResolvedValue(undefined);
	},
	play: async ({ canvas, userEvent, args }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Add condition" }));
		await userEvent.type(canvas.getByLabelText("JSON path"), "action");
		await userEvent.type(canvas.getByLabelText("Accepted value 1"), "create");
		await userEvent.click(canvas.getByRole("button", { name: "Save condition" }));
		await expect(await canvas.findByRole("alert")).toBeVisible();
		await expect(canvas.getByLabelText("JSON path")).toHaveValue("action");
		await expect(canvas.getByLabelText("Accepted value 1")).toHaveValue("create");
		await userEvent.click(canvas.getByRole("button", { name: "Save condition" }));
		await waitFor(() => expect(args.onChange).toHaveBeenCalledTimes(2));
		await expect(await canvas.findByText('"create"')).toBeVisible();
	},
});

/** Invalid paths cannot be saved and cancelling a condition leaves the filter unchanged. */
export const Validation = meta.story({
	play: async ({ canvas, userEvent, args }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Add condition" }));
		await userEvent.type(canvas.getByLabelText("JSON path"), "data..name");
		await expect(canvas.getByRole("button", { name: "Save condition" })).toBeDisabled();
		await userEvent.click(canvas.getByRole("button", { name: "Cancel condition" }));
		await expect(args.onChange).not.toHaveBeenCalled();
	},
});

/** The editor respects the API's condition and value limits. */
export const Limits = meta.story({
	args: {
		filter: Array.from({ length: MAX_WEBHOOK_FILTER_CONDITIONS }, (_, index) => ({
			path: `field${index}`,
			oneOf: Array.from({ length: MAX_WEBHOOK_FILTER_VALUES }, (_, value) => String(value)),
		})),
	},
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.queryByRole("button", { name: "Add condition" })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Edit condition 1" }));
		await expect(canvas.queryByRole("button", { name: "Add value" })).toBeNull();
	},
});

/** Filter fields stack vertically on phones. */
export const Phone = meta.story({
	...ExactValues.input,
	globals: { viewport: { value: "iphone12", isRotated: false }, theme: "light" },
});
