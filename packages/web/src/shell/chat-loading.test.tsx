import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, onWideScreen, taskWith } from "@/test-api.tsx";

const chatModule = vi.hoisted(() => Promise.withResolvers<void>());
const newTaskModule = vi.hoisted(() => Promise.withResolvers<void>());

vi.mock("@/api.ts", () => import("@/test-client.ts"));
vi.mock("@/screens/ConversationPage.tsx", async (importOriginal) => {
	await chatModule.promise;
	return importOriginal<typeof import("@/screens/ConversationPage.tsx")>();
});
vi.mock("@/screens/NewTask.tsx", async (importOriginal) => {
	await newTaskModule.promise;
	return importOriginal<typeof import("@/screens/NewTask.tsx")>();
});

afterEach(() => {
	cleanup();
	chatModule.resolve();
	newTaskModule.resolve();
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("keeps the bot's sidebar visible while the chat screen loads", async () => {
	apiAnswers();
	mount(`/suga/bots/${linear.handle}/tasks/${taskWith(linear).id}`);

	// The bot whose task is opening has its own sidebar.
	const rail = await screen.findByRole("navigation", { name: "Sidebar" });
	await within(rail).findByRole("navigation", { name: `${linear.name}'s pages` });
	expect(screen.queryAllByRole("heading", { name: "Working with Linear Handler" })).toHaveLength(0);

	await act(async () => {
		chatModule.resolve();
		await import("@/screens/ConversationPage.tsx");
	});
	expect(
		await screen.findAllByRole("heading", { name: "Working with Linear Handler" }),
	).not.toHaveLength(0);
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(rail);
});

it("keeps the sidebar, with the bot in it, while the new task screen loads", async () => {
	localStorage.clear();
	onWideScreen();
	apiAnswers();
	mount(`/suga/bots/${linear.handle}/new`);

	const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
	expect(
		await within(sidebar).findByRole("navigation", { name: `${linear.name}'s pages` }),
	).toBeDefined();

	await act(async () => {
		newTaskModule.resolve();
		await import("@/screens/NewTask.tsx");
	});
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(sidebar);
});
