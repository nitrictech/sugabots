import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, onWideScreen } from "@/test-api.tsx";

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

it("keeps the sidebar and its bots visible while the chat screen loads", async () => {
	apiAnswers();
	mount(`/suga/bots/${linear.handle}`);

	// The bot whose task is opening is open in the sidebar.
	const rail = await screen.findByRole("navigation", { name: "Sidebar" });
	await within(rail).findByRole("link", { name: linear.name });
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
	expect(await within(sidebar).findByRole("link", { name: linear.name })).toBeDefined();

	await act(async () => {
		newThreadModule.resolve();
		await import("@/screens/NewThread.tsx");
	});
	expect(screen.getByRole("navigation", { name: "Sidebar" })).toBe(sidebar);
});
