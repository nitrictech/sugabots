import { act, cleanup, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { agents, apiAnswers, linear, mount, pendingAnswer } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

const chatModule = vi.hoisted(() => Promise.withResolvers<void>());
const newThreadModule = vi.hoisted(() => Promise.withResolvers<void>());

vi.mock("@/api.ts", () => import("@/test-client.ts"));
vi.mock("@/screens/ConversationPage.tsx", async (importOriginal) => {
	await chatModule.promise;
	return importOriginal<typeof import("@/screens/ConversationPage.tsx")>();
});
vi.mock("@/screens/NewThread.tsx", async (importOriginal) => {
	await newThreadModule.promise;
	return importOriginal<typeof import("@/screens/NewThread.tsx")>();
});

afterEach(() => {
	cleanup();
	chatModule.resolve();
	newThreadModule.resolve();
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("keeps the sidebar and its conversations visible while the chat screen loads", async () => {
	apiAnswers();
	const roster = pendingAnswer();
	client.api.agents.list.mockReturnValue(roster.effect);
	mount(`/suga/pods/suga-team/agents/${linear.handle}`);

	// The bot whose chat is opening is open in the sidebar, with its thread.
	const rail = await screen.findByRole("navigation", { name: "Sidebar" });
	await screen.findByRole("link", { name: new RegExp(`Conversation with ${linear.name}`) });

	// React Query hands the answer to components on a zero-delay timer. Until it
	// runs, nothing has suspended, and these checks would pass even if the frame vanished.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await act(async () => {
		roster.answer(Effect.succeed(agents));
		await vi.advanceTimersByTimeAsync(1_000);
	});
	vi.useRealTimers();
	// Role queries exclude DOM hidden by the enclosing Suspense boundary.
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(rail);
	expect(
		screen
			.getByRole("link", { name: new RegExp(`Conversation with ${linear.name}`) })
			.getAttribute("aria-current"),
	).toBe("page");
	expect(screen.queryAllByRole("heading", { name: linear.name })).toHaveLength(0);

	await act(async () => {
		chatModule.resolve();
		await import("@/screens/ConversationPage.tsx");
	});
	// The bot's name heads more than one part of the chat screen.
	expect(await screen.findAllByRole("heading", { name: linear.name })).not.toHaveLength(0);
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(rail);
});

it("keeps the sidebar, with the bot open, while the new thread screen loads", async () => {
	// Nothing opened by hand before: the bot is open because a thread is being started with it.
	localStorage.clear();
	apiAnswers();
	mount(`/suga/pods/suga-team/threads/new?agent=${linear.handle}`);

	const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
	const bot = await within(sidebar).findByRole("button", { name: linear.name });
	expect(bot.getAttribute("aria-expanded")).toBe("true");

	await act(async () => {
		newThreadModule.resolve();
		await import("@/screens/NewThread.tsx");
	});
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(sidebar);
});
