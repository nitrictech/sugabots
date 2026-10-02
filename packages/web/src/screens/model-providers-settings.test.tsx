import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, modelProviders, mount } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
});

afterEach(cleanup);

const [openai] = modelProviders;
if (!openai) throw new Error("fixture");

describe("a provider's API key", () => {
	it("is masked, and replaced without being shown", async () => {
		mount(`/suga/settings/providers/${openai.id}`);

		expect(await screen.findByText("••••••••")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Replace" }));
		const field = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
		expect(field.type).toBe("password");
		expect(field.value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("••••••••")).toBeDefined();
	});
});

describe("switching a provider on", () => {
	it("switches it on and nothing else", async () => {
		const off = { ...openai, active: false };
		const providers = client.api.modelProviders;
		providers.list.mockReturnValue(Effect.succeed([off]));
		providers.update.mockReturnValue(Effect.succeed({ ...off, active: true }));
		mount(`/suga/settings/providers/${openai.id}`);

		fireEvent.click(await screen.findByRole("switch", { name: `Use ${openai.name}` }));

		await waitFor(() =>
			expect(providers.update.mock.calls[0]?.[0]).toMatchObject({ payload: { active: true } }),
		);
		expect(providers.test).not.toHaveBeenCalled();
	});
});

describe("a model's capabilities", () => {
	/** A server the workspace added itself, whose models' capabilities are set here. */
	const gateway = {
		...openai,
		id: "0199a3a0-0000-7000-8000-0000000000cf",
		preset: null,
		name: "Company gateway",
	};

	it("can be switched off within what the server reports, and not on beyond it", async () => {
		const providers = client.api.modelProviders;
		const [gpt] = gateway.models;
		if (!gpt) throw new Error("fixture");
		providers.list.mockReturnValue(Effect.succeed([gateway]));
		providers.updateModel.mockImplementation(() => {
			providers.list.mockReturnValue(
				Effect.succeed([{ ...gateway, models: [{ ...gpt, disabledCapabilities: ["vision"] }] }]),
			);
			return Effect.succeed({ updated: 1 });
		});
		mount(`/suga/settings/providers/${gateway.id}`);

		expect(await screen.findByRole("img", { name: "Vision" })).toBeDefined();
		fireEvent.click(await screen.findByRole("button", { name: "What gpt-5 can do" }));
		const dialog = await screen.findByRole("dialog", { name: "What it can do" });
		// gpt-5 reports tools, vision and images: those can go off, the rest are not offered.
		expect(within(dialog).queryByRole("switch", { name: "Reasoning" })).toBeNull();
		fireEvent.click(within(dialog).getByRole("switch", { name: "Vision" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(providers.updateModel).toHaveBeenCalledWith({
				params: { workspace: expect.any(String), providerId: gateway.id, modelId: gpt.id },
				payload: { disabledCapabilities: ["vision"] },
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "What it can do" })).toBeNull(),
		);
		await waitFor(() => expect(screen.queryByRole("img", { name: "Vision" })).toBeNull());
	});
});
