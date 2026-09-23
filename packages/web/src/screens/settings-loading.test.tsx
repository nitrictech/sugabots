import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, mount } from "@/test-api.tsx";

const settingsDownload = vi.hoisted(() => {
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return { pending, finish };
});

vi.mock("@/api.ts", () => import("@/test-client.ts"));
vi.mock("@/screens/WorkspaceSettings.tsx", async () => {
	await settingsDownload.pending;
	return { WorkspaceSettings: () => <h2>Settings loaded</h2> };
});

beforeEach(apiAnswers);
afterEach(cleanup);

describe("settings loading", () => {
	it("opens the dialog before its code finishes downloading", async () => {
		const router = mount("/suga/pods/suga-team/agents/linear-handler");
		await screen.findByRole("link", { name: "Configure Linear Handler" });
		const navigation = router.navigate({
			to: "/$workspace/settings",
			params: { workspace: "suga" },
		});
		try {
			expect(await screen.findByRole("dialog", { name: "Workspace settings" })).toBeDefined();
			expect(screen.queryByRole("heading", { name: "Settings loaded" })).toBeNull();
		} finally {
			settingsDownload.finish();
			await navigation;
		}
		expect(await screen.findByRole("heading", { name: "Settings loaded" })).toBeDefined();
	});
});
