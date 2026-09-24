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

describe("a provider's API key", () => {
	it("can be shown while it is being pasted, and never once saved", async () => {
		mount("/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		const field = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
		fireEvent.change(field, { target: { value: " sk-with-a-space" } });
		expect(field.type).toBe("password");

		fireEvent.click(screen.getByRole("button", { name: "Show what you pasted" }));
		expect(field.type).toBe("text");
		expect(field.value).toBe(" sk-with-a-space");

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("••••••••")).toBeDefined();
		expect(screen.queryByRole("button", { name: /API key/ })).toBeNull();
	});
});

describe("a model's capabilities", () => {
	it("can be switched off within what the provider reports, and not on beyond it", async () => {
		const providers = client.api.modelProviders;
		const [openai] = modelProviders;
		const [gpt] = openai?.models ?? [];
		if (!openai || !gpt) throw new Error("fixture");
		providers.updateModel.mockImplementation(() => {
			providers.list.mockReturnValue(
				Effect.succeed([{ ...openai, models: [{ ...gpt, disabledCapabilities: ["vision"] }] }]),
			);
			return Effect.succeed({ updated: 1 });
		});
		mount("/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Edit gpt-5 capabilities" }));
		const dialog = await screen.findByRole("dialog", { name: "Capabilities" });
		// gpt-5 reports tools, vision and images: those can go off, the rest cannot go on.
		expect(within(dialog).getByRole("switch", { name: "Turn on Reasoning" })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.click(within(dialog).getByRole("switch", { name: "Turn off Vision" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(providers.updateModel).toHaveBeenCalledWith({
				params: { workspace: expect.any(String), providerId: openai.id, modelId: gpt.id },
				payload: { disabledCapabilities: ["vision"] },
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Capabilities" })).toBeNull());
		expect(await screen.findByLabelText("Vision (off)")).toBeDefined();
	});
});
