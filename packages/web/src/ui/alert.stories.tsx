import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { Alert } from "./alert.tsx";

const meta = preview.meta({
	title: "Controls/Alert",
	component: Alert,
	tags: ["ai-generated"],
	args: { children: "Models could not be loaded. Close this form and try again." },
});

/** Something went wrong, said in red where it happened, and announced. */
export const Failure = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("alert")).toHaveTextContent("Models could not be loaded");
	},
});

/** Several lines, as a list of what failed. */
export const SeveralLines = meta.story({
	args: {
		children: (
			<>
				<span style={{ display: "block" }}>kim@example.com: Offline</span>
				<span style={{ display: "block" }}>jay@example.com: Already a member</span>
			</>
		),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("alert")).toHaveTextContent("jay@example.com");
	},
});
