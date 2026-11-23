import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import { LiveDocument } from "./LiveDocument.tsx";

/** Where the stand-in API listens, which the screen is told is where the API is. */
const PORT = 43_217;

vi.mock("@/lib/api-url.ts", () => ({ apiBaseUrl: "http://127.0.0.1:43217/api" }));

const ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000002";

let api: ChildProcess | undefined;

beforeAll(async () => {
	// Node's own WebSocket, the global here, cannot dispatch jsdom's events.
	vi.stubGlobal("WebSocket", NodeWebSocket);
	api = fork(join(import.meta.dirname, "live-document.test-server.ts"), [String(PORT)]);
	const listening = api;
	await new Promise((resolve) => listening.once("message", resolve));
});
afterEach(cleanup);
afterAll(() => {
	vi.unstubAllGlobals();
	api?.kill();
});

describe("a document being edited live", () => {
	it("shows the document, then a bot's change to it and the bot's name as it lands", async () => {
		render(
			<TooltipProvider>
				<LiveDocument
					workspaceId="workspace"
					podId="pod"
					artifactId={ARTIFACT_ID}
					title="Launch plan"
					as={{ name: "Sam", email: "sam@example.com" }}
					bot={{ agentId: "agent", name: "Planner" }}
					onWordImport={() => {}}
					presenceSlot={document.body}
					statusSlot={null}
				/>
			</TooltipProvider>,
		);

		expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeDefined();
		expect(screen.getByText("Ship on Friday.")).toBeDefined();

		api?.send({ artifactId: ARTIFACT_ID, ask: "rewrite" });

		await waitFor(() => expect(screen.getByText("Ship on Monday.")).toBeDefined());
		expect(screen.getByRole("img", { name: "Planner" })).toBeDefined();
	});

	it("stops and says to reload when the document holds a block it cannot, deleting nothing", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000003";
		render(
			<TooltipProvider>
				<LiveDocument
					workspaceId="workspace"
					podId="pod"
					artifactId={artifactId}
					title="Launch plan"
					as={{ name: "Sam", email: "sam@example.com" }}
					bot={undefined}
					onWordImport={() => {}}
					presenceSlot={document.body}
					statusSlot={null}
				/>
			</TooltipProvider>,
		);
		expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeDefined();

		// Somebody on a newer version of the app adds a block this editor has no node for.
		api?.send({ artifactId, ask: "unknown block" });

		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			expect.stringContaining("Reload to get the latest editor"),
		);
		// The heading, the paragraph and the block from elsewhere are all still in the document.
		const counted = new Promise<{ blocks: number }>((resolve) => api?.once("message", resolve));
		api?.send({ artifactId, ask: "count blocks" });
		expect(await counted).toEqual({ blocks: 3 });
	});
});
