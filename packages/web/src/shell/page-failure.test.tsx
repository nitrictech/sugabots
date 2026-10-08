import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiAnswers, mount } from "@/test-api.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));
// As a tab opened before a deploy finds it: the chunk is gone, so the import fails.
vi.mock("@/screens/WorkspaceSettings.tsx", () => {
	throw new Error("chunk missing");
});

beforeEach(() => {
	apiAnswers();
	// React reports every error a boundary catches; this one is the point of the test.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("keeps the rail and offers a reload when a page's code fails to download", async () => {
	mount("/suga/settings");

	expect(await screen.findByText("This page could not load")).toBeDefined();
	expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
	expect(screen.getByRole("navigation", { name: "Pods" })).toBeDefined();
});
