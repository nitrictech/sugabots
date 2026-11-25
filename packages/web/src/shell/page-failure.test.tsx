import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, it, vi } from "vitest";
import { apiAnswers, mount, onWideScreen } from "@/api.test-support.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));
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

it("keeps the sidebar and offers a reload when a page's code fails to download", async () => {
	onWideScreen();
	mount("/suga/settings");

	await screen.findByText("This page could not load");
	screen.getByRole("button", { name: "Reload" });
	screen.getByRole("navigation", { name: "Sidebar" });
});
