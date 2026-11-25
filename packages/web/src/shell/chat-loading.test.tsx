import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiAnswers, chatWith, linear, mount, onWideScreen } from "@/api.test-support.tsx";

const chatModule = vi.hoisted(() => Promise.withResolvers<void>());
const newChatModule = vi.hoisted(() => Promise.withResolvers<void>());

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));
vi.mock("@/screens/ChatPage.tsx", async (importOriginal) => {
	await chatModule.promise;
	return importOriginal<typeof import("@/screens/ChatPage.tsx")>();
});
vi.mock("@/screens/NewChatPage.tsx", async (importOriginal) => {
	await newChatModule.promise;
	return importOriginal<typeof import("@/screens/NewChatPage.tsx")>();
});

afterEach(() => {
	cleanup();
	chatModule.resolve();
	newChatModule.resolve();
	vi.useRealTimers();
});

it("keeps the bot's sidebar visible while the chat screen loads", async () => {
	apiAnswers();
	mount(`/suga/bots/${linear.handle}/chats/${chatWith(linear).id}`);

	// The bot whose chat is opening has its own sidebar.
	const rail = await screen.findByRole("navigation", { name: "Sidebar" });
	await within(rail).findByRole("navigation", { name: `${linear.name}'s pages` });
	expect(screen.queryAllByRole("heading", { name: "Working with Linear Handler" })).toHaveLength(0);

	await act(async () => {
		chatModule.resolve();
		await import("@/screens/ChatPage.tsx");
	});
	expect(
		await screen.findAllByRole("heading", { name: "Working with Linear Handler" }),
	).not.toHaveLength(0);
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(rail);
});

it("keeps the sidebar, with the bot in it, while the new chat screen loads", async () => {
	localStorage.clear();
	onWideScreen();
	apiAnswers();
	mount(`/suga/bots/${linear.handle}`);

	const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
	await within(sidebar).findByRole("navigation", { name: `${linear.name}'s pages` });

	await act(async () => {
		newChatModule.resolve();
		await import("@/screens/NewChatPage.tsx");
	});
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(sidebar);
});
