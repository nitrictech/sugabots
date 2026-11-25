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
	it("slides a page further in over the one it was opened from", async () => {
		const started = recordViewTransitions();
		const { router } = mount("/suga/settings");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({
			to: "/$workspace/settings/$section",
			params: { workspace: "suga", section: "account" },
		});

		expect(started).toHaveBeenCalledWith(expect.objectContaining({ types: ["forward"] }));
	});

	it("starts no transition for somebody who asks for reduced motion", async () => {
		const started = recordViewTransitions();
		prefersReducedMotion();
		const { router } = mount("/suga/settings");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({
			to: "/$workspace/settings/$section",
			params: { workspace: "suga", section: "account" },
		});

		expect(router.state.location.pathname).toBe("/suga/settings/account");
		expect(started).not.toHaveBeenCalled();
	});
});

describe("a chat's address by its id alone", () => {
	it("goes on to a project's chat, keeping the file it opens", async () => {
		const project = projects[0];
		if (!project) throw new Error("The fixtures have no project");
		const chat = {
			...chatWith(triager),
			id: "0199a3a0-0000-7000-8000-0000000c0001",
			projectId: project.id,
			title: "Launch plan",
		};
		client.api.chats.get.mockReturnValue(Effect.succeed(chatDetails(triager, chat)));
		const file = "0199a3a0-0000-7000-8000-0000000f0001";

		const { router } = mount(`/suga/chats/${chat.id}?file=${file}`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/projects/${project.slug}/${chat.id}`),
		);
		expect(router.state.location.search).toEqual({ file });
		expect(screen.queryByText("Chat not found")).toBeNull();
	});
});
