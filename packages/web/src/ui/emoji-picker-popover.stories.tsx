import { useState } from "react";
import { expect, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { EmojiPickerPopover } from "./emoji-picker-popover.tsx";

const meta = preview.meta({
	title: "Controls/EmojiPickerPopover",
	component: EmojiPickerPopover,
	args: { label: "Add reaction", trigger: <Button>Add reaction</Button>, onSelect: () => true },
});

/** ChooseReaction opens the picker above the reaction button. */
export const ChooseReaction = meta.story({
	render: function ReactionPicker() {
		const [reaction, setReaction] = useState("");
		return (
			<div className="flex min-h-96 items-end gap-3">
				<EmojiPickerPopover
					label="Add reaction"
					trigger={<Button variant="secondary">Add reaction</Button>}
					onSelect={(emoji) => {
						setReaction(emoji);
						return true;
					}}
				/>
				{reaction && <p>Selected reaction: {reaction}</p>}
			</div>
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Add reaction" }));
		const picker = await screen.findByRole("dialog", { name: "Add reaction" });
		const search = within(picker).getByRole("searchbox", { name: "Search emoji" });
		await waitFor(() => expect(search).toHaveFocus());
	},
});
