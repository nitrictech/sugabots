import { act, cleanup, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { agents, apiAnswers, linear, mount, pendingAnswer } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

const chatModule = vi.hoisted(() => Promise.withResolvers<void>());

vi.mock("@/api.ts", () => import("@/test-client.ts"));
vi.mock("@/screens/AgentPage.tsx", async (importOriginal) => {
	await chatModule.promise;
	return importOriginal<typeof import("@/screens/AgentPage.tsx")>();
});

afterEach(() => {
	cleanup();
	chatModule.resolve();
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("keeps the rail and conversation list visible while the chat screen loads", async () => {
	apiAnswers();
	const roster = pendingAnswer();
	client.api.agents.list.mockReturnValue(roster.effect);
	mount(`/suga/pods/suga-team/agents/${linear.handle}`);

	const rail = await screen.findByRole("navigation", { name: "Pods" });
	await screen.findByRole("link", { name: new RegExp(linear.name) });

	// React Query hands the answer to components on a zero-delay timer. Until it
	// runs, nothing has suspended, and these checks would pass even if the frame vanished.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await act(async () => {
		roster.answer(Effect.succeed(agents));
		await vi.advanceTimersByTimeAsync(1_000);
	});
	vi.useRealTimers();
	// Role queries exclude DOM hidden by the enclosing Suspense boundary.
	expect(screen.getByRole("navigation", { name: "Pods" })).toBe(rail);
	expect(
		screen.getByRole("link", { name: new RegExp(linear.name) }).getAttribute("aria-current"),
	).toBe("page");
	expect(screen.queryByRole("heading", { name: linear.name })).toBeNull();

	await act(async () => {
		chatModule.resolve();
		await import("@/screens/AgentPage.tsx");
	});
	expect(await screen.findByRole("heading", { name: linear.name })).toBeDefined();
	expect(screen.getByRole("navigation", { name: "Pods" })).toBe(rail);
});
