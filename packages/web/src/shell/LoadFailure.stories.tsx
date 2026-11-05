import { InternalServerError } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { LoadFailure } from "./LoadFailure.tsx";

const meta = preview.meta({
	title: "Product/LoadFailure",
	component: LoadFailure,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		title: "Could not load your workspace",
		error: new Error("Failed to fetch"),
		retry: fn(() => Promise.resolve()),
	},
	decorators: [
		(Story) => (
			<div className="h-120">
				<Story />
			</div>
		),
	],
});

/** The request never reached the API, as while a release restarts it. */
export const Unreachable = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Could not reach the API")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled();
	},
});

/** The API answered with a failure, which is said as it is. */
export const Answered = meta.story({
	args: {
		error: new InternalServerError({ message: userText`The database is not available` }),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("The database is not available")).toBeInTheDocument();
	},
});

/** While asking again, the button says so and waits. */
export const TryingAgain = meta.story({
	args: { retry: fn(() => new Promise<void>(() => {})) },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
		await expect(canvas.getByRole("button", { name: "Trying again…" })).toBeDisabled();
	},
});
