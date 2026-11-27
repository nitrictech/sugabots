import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	chatWith,
	linear,
	mount,
	open,
	personalAssistant,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

beforeEach(() => {
	apiAnswers();
	client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
});

/** Opens the computer sheet from the ⋯ of a chat with `bot`, as a phone does. */
async function openComputerSheet(bot: typeof linear) {
	mount(`/suga/bots/${bot.handle}/chats/${chatWith(bot).id}`);
	open(await screen.findByRole("button", { name: "More for this chat" }));
	fireEvent.click(await screen.findByRole("menuitem", { name: "Computer" }));
	return screen.findByText(`${bot.name} doesn't have a computer`);
}

describe("a bot's computer sheet, while the bot has no computer", () => {
	it.each([
		["a bot they manage", linear],
		["their own Personal Assistant", personalAssistant],
	])("offers to turn one on to whoever manages its computer, for %s", async (_, bot) => {
		await openComputerSheet(bot);

		screen.getByRole("button", { name: "Turn on computer" });
	});
});

describe("a bot's computer sheet, while the workspace has no computers", () => {
	it("closes as it opens Computers over the chat", async () => {
		client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: false }));
		mount(`/suga/bots/${linear.handle}/chats/${chatWith(linear).id}`);
		open(await screen.findByRole("button", { name: "More for this chat" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Computer" }));

		fireEvent.click(await screen.findByRole("link", { name: "Set up computers" }));

		await screen.findByRole("heading", { name: "Computers", level: 2 });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
