import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, chatPath, StoryApp, storyChatFor } from "@/story-app.test-support.tsx";

const meta = preview.meta({
	title: "Product/Chat Header",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
});

/** PhoneDetailsBadge shows the Details badge in the phone chat header’s tab order. */
export const PhoneDetailsBadge = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas, userEvent }) => {
		const title = storyChatFor(growthDesk).title;
		await expect(await canvas.findByRole("heading", { name: title, level: 1 })).toBeInTheDocument();
		const back = canvas.getByRole("link", { name: `Back to ${growthDesk.name}` });
		const details = canvas.getByRole("button", { name: `Details for ${title}` });
		back.focus();
		await userEvent.tab();
		await expect(details).toHaveFocus();
	},
});
