import { fireEvent, screen } from "@testing-library/react";
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
	it("offers to turn one on to whoever manages its computer", async () => {
		await openComputerSheet(linear);

		screen.getByRole("button", { name: "Turn on computer" });
	});

	it("offers no computer for a Personal Assistant, which Sugabots sets up", async () => {
		await openComputerSheet(personalAssistant);

		expect(screen.queryByRole("button", { name: "Turn on computer" })).toBeNull();
		screen.getByText("Sugabots sets up your Personal Assistant, its computer included.");
	});
});
