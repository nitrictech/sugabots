import type {
	ProjectComputer as ProjectComputerDetails,
	ProjectComputerNetwork,
} from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyWorkspace } from "@/story-app.test-support.tsx";

const computer = {
	providerEnabled: true,
	computer: {
		kind: "present",
		state: "running",
		image: "ghcr.io/nitrictech/sugabots-sandbox:latest",
		providerName: "OpenSandbox",
		createdAt: "2026-09-29T09:00:00.000Z",
		lastUsedAt: "2026-10-02T05:40:00.000Z",
		turnsUsing: 1,
		membersWatching: 0,
		upgradeAvailable: false,
		disk: {
			usedBytes: 4 * 1024 ** 3,
			totalBytes: 20 * 1024 ** 3,
			measuredAt: "2026-10-02T05:38:00.000Z",
			folders: [],
		},
	},
} satisfies ProjectComputerDetails;

const network = {
	mode: "allowed-hosts-only",
	blocking: true,
	workspaceHosts: [{ host: "github.com", blockedBy: null }],
	addedHosts: [{ host: "api.stripe.com", addedByName: "Sam Rivera", blockedBy: null }],
} satisfies ProjectComputerNetwork;

const meta = preview.meta({
	title: "Views/Resource Settings",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		const address = `${import.meta.env.VITE_API_URL}/projects/${revenue.id}/computer`;
		msw.use(
			http.get(address, () => HttpResponse.json(computer)),
			http.get(`${address}/network`, () => HttpResponse.json(network)),
			...appHandlers(),
		);
	},
});

/** ProjectComputer shows the project's running computer, disk and allowed hosts. */
export const ProjectComputer = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/projects/${revenue.slug}/computer`} />,
	play: async ({ canvas }) => {
		const page = within(await canvas.findByRole("region", { name: "Computers" }));
		await expect(await page.findByText("Running")).toBeVisible();
		await expect(page.getByRole("meter", { name: "Disk used" })).toHaveValue(20);
		await expect(await page.findByText("api.stripe.com")).toBeVisible();
	},
});
