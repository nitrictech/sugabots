import { screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	apiAnswers,
	chatDetails,
	chatWith,
	mount,
	prefersReducedMotion,
	projects,
	triager,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

type TransitionRequest = { update: () => Promise<void>; types: string[] } | (() => Promise<void>);

/**
 * A browser that runs view transitions and can tell their types, which jsdom
 * cannot: each transition started is recorded, and its update applied at once.
 */
function recordViewTransitions() {
	const started = vi.fn((request: TransitionRequest) => {
		const update = typeof request === "function" ? request : request.update;
		return { updateCallbackDone: update(), ready: Promise.resolve(), finished: Promise.resolve() };
	});
	Object.defineProperty(document, "startViewTransition", { configurable: true, value: started });
	vi.stubGlobal("CSS", { supports: () => true });
	onTestFinished(() => {
		Reflect.deleteProperty(document, "startViewTransition");
		vi.unstubAllGlobals();
	});
	return started;
}

beforeEach(() => {
	apiAnswers();
});

describe("moving between pages on a phone", () => {
	it("slides a page of the settings in over You, and back out of it", async () => {
		const started = recordViewTransitions();
		const { router } = mount("/suga/you");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({ to: ".", search: { settings: "account" } });
		expect(started).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["forward"] }));

		router.history.back();
		await waitFor(() =>
			expect(started).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["back"] })),
		);
	});

	it("starts no transition for somebody who asks for reduced motion", async () => {
		const started = recordViewTransitions();
		prefersReducedMotion();
		const { router } = mount("/suga/you");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({ to: ".", search: { settings: "account" } });

		expect(router.state.location.search).toEqual({ settings: "account" });
		expect(started).not.toHaveBeenCalled();
	});
});

describe("a chat's address by its id alone", () => {
	it.each([
		{ path: "/suga/chats", focus: "file" },
		{ path: "/suga/activity/launch", focus: "message" },
	])("goes on from $path to a project's chat, keeping its $focus", async ({ path, focus }) => {
		const project = projects[0];
		if (!project) throw new Error("The fixtures have no project");
		const chat = {
			...chatWith(triager),
			id: "0199a3a0-0000-7000-8000-0000000c0001",
			projectId: project.id,
			title: "Launch plan",
		};
		client.api.chats.get.mockReturnValue(Effect.succeed(chatDetails(triager, chat)));
		const target = "0199a3a0-0000-7000-8000-0000000f0001";

		const { router } = mount(`${path}/${chat.id}?${focus}=${target}`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/projects/${project.slug}/${chat.id}`),
		);
		expect(router.state.location.search).toEqual({ [focus]: target });
		expect(screen.queryByText("Chat not found")).toBeNull();
	});

	it("shows chat not found when an old notification names an unavailable chat", async () => {
		const chatId = "0199a3a0-0000-7000-8000-0000000c0001";
		mount(`/suga/activity/launch/${chatId}`);

		await screen.findByText("Chat not found");
		expect(client.api.chats.get).toHaveBeenCalledWith(
			expect.objectContaining({ params: { chatId } }),
		);
	});
});
