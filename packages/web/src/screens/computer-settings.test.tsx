import type { ComputerNetworkSettings, ProjectComputerDisk } from "@sugabots/contracts";
import { cleanup, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, linear, mount, projects } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

// The shared stand-in answers only whether computers are on; this page reads the rest.
const computerProviders = Object.assign(client.api.computerProviders, {
	list: vi.fn(),
	network: vi.fn(),
	disks: vi.fn(),
});

const network: ComputerNetworkSettings = {
	mode: "open",
	blocking: true,
	trustedHosts: [],
	addedHosts: [],
	blockedHosts: [],
};

const GB = 1024 ** 3;
const diskOf = (projectId: string, usedGB: number): ProjectComputerDisk => ({
	projectId,
	disk: {
		usedBytes: usedGB * GB,
		totalBytes: 20 * GB,
		measuredAt: "2026-10-02T05:38:00.000Z",
		folders: null,
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	apiAnswers();
	computerProviders.list.mockReturnValue(Effect.succeed([]));
	computerProviders.network.mockReturnValue(Effect.succeed(network));
});

afterEach(cleanup);

describe("the Computers settings", () => {
	it("lists the disk of a project people made beside a bot's, each named for its owner", async () => {
		const [suga] = projects;
		computerProviders.disks.mockReturnValue(
			Effect.succeed([diskOf(linear.defaultProjectId, 4), diskOf(suga?.id ?? "", 12)]),
		);
		mount("/suga/settings/computers");

		const disks = await screen.findByRole("region", { name: "Disk use" });
		const rows = within(disks).getAllByRole("link");
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining(suga?.name ?? ""),
			expect.stringContaining(linear.name),
		]);
		expect(rows[0]?.getAttribute("href")).toMatch(/\/settings\/projects\/suga-team\/computer$/);
	});
});
