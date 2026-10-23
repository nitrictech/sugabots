import { QueryClientProvider } from "@tanstack/react-query";
import { delay, HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { expect, fn, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import {
	idleLaptop,
	inDesktopApp,
	lendingLaptop,
	lentInDocs,
	lentInSugabots,
	offlineDesktop,
} from "./device-story-fixtures.ts";
import { DeviceAgentList, DeviceAgentPicker } from "./RunsOn.tsx";

/*
 * Choosing an agent on your computer for a bot to stand for: the agents it
 * lends while the desktop app is connected, and lending another there, in a
 * folder chosen on the computer. The list is drawn with whichever computers
 * it's given; DeviceAgentPicker, below, gives it only the one the desktop
 * app's window is on.
 */

const API = import.meta.env.VITE_API_URL;

function Cache({ children }: { children: ReactNode }) {
	const [client] = useState(() => createQueryClient());
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The kinds the story's lend requests asked for, by device. */
let lendRequests: { deviceId: string; kind: unknown }[] = [];

const lendAnswering = (answer: () => Promise<Response> | Response) =>
	http.post(`${API}/devices/:deviceId/agents`, async ({ params, request }) => {
		const { kind } = (await request.json()) as { kind: unknown };
		lendRequests.push({ deviceId: String(params.deviceId), kind });
		return answer();
	});

const meta = preview.meta({
	title: "Product/DeviceAgentList",
	component: DeviceAgentList,
	tags: ["ai-generated"],
	args: { devices: [], chosen: undefined, onChoose: fn() },
	beforeEach() {
		lendRequests = [];
	},
	render: (args) => (
		<Cache>
			<div className="flex max-w-[560px] flex-col gap-6">
				<DeviceAgentList {...args} />
			</div>
		</Cache>
	),
});

/** A connected computer lends its agents, each with its folder; choosing one hands back the device and the agent. */
export const OnlineWithAgents = meta.story({
	args: { devices: [lendingLaptop] },
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByRole("heading", { name: "Tim's MacBook" })).toBeInTheDocument();
		await expect(canvas.getByText(lentInSugabots.workingDirectory)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: /Claude Code in sugabots/ }));
		await expect(args.onChoose).toHaveBeenCalledWith({
			deviceId: lendingLaptop.id,
			agent: lentInSugabots,
		});
	},
});

/** The chosen agent is marked as pressed. */
export const Chosen = meta.story({
	args: {
		devices: [lendingLaptop],
		chosen: { deviceId: lendingLaptop.id, url: lentInDocs.url },
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Claude Code in docs/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(canvas.getByRole("button", { name: /Claude Code in sugabots/ })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	},
});

/** Claude Code found on a computer that lends nothing yet: lending it there chooses what was lent. */
export const InstalledNothingLent = meta.story({
	args: { devices: [idleLaptop] },
	beforeEach({ msw }) {
		msw.use(lendAnswering(() => HttpResponse.json(lentInSugabots, { status: 201 })));
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByText("Claude Code 2.1.300")).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
		await waitFor(() =>
			expect(args.onChoose).toHaveBeenCalledWith({
				deviceId: idleLaptop.id,
				agent: lentInSugabots,
			}),
		);
		await expect(lendRequests).toEqual([{ deviceId: idleLaptop.id, kind: "claude-code" }]);
	},
});

/** While its owner chooses a folder on the computer, the row says to look there, and the wait can be given up. */
export const LendingInProgress = meta.story({
	args: { devices: [idleLaptop] },
	beforeEach({ msw }) {
		msw.use(lendAnswering(() => delay("infinite").then(() => HttpResponse.json(lentInSugabots))));
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
		await expect(
			await canvas.findByText(/Choose the folder on Work laptop, where the desktop app is asking/),
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Stop waiting" }));
		await expect(canvas.getByRole("button", { name: "Connect" })).toBeInTheDocument();
	},
});

/** Its owner declined on the computer: quietly not lent, nothing chosen. */
export const Declined = meta.story({
	args: { devices: [idleLaptop] },
	beforeEach({ msw }) {
		msw.use(
			lendAnswering(() =>
				HttpResponse.json(
					{ _tag: "Conflict", message: "Not lent on that computer." },
					{ status: 409 },
				),
			),
		);
	},
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
		await expect(await canvas.findByText("Not lent.")).toBeInTheDocument();
		await expect(args.onChoose).not.toHaveBeenCalled();
	},
});

/** A computer without the desktop app running shows as offline, with nothing to choose or lend. */
export const Offline = meta.story({
	args: { devices: [lendingLaptop, offlineDesktop] },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Studio desktop" })).toBeInTheDocument();
		await expect(canvas.getByText("Not connected")).toBeInTheDocument();
		// The laptop's two lent agents and its one lend action.
		await expect(canvas.getAllByRole("button")).toHaveLength(3);
	},
});

/** This computer isn't among the person's paired ones: says how to pair it. */
export const NoDevices = meta.story({
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText(/Choose Pair this computer from the Sugabots desktop app's tray menu/),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button")).toBeNull();
	},
});

/**
 * In the desktop app on the laptop, the picker shows only the laptop: another
 * paired computer's agents are lent and chosen from that computer.
 */
export const PickerOnThisComputer = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop, idleLaptop])));
		return inDesktopApp(lendingLaptop.id);
	},
	render: (args) => (
		<Cache>
			<div className="flex max-w-[560px] flex-col gap-6">
				<DeviceAgentPicker chosen={undefined} onChoose={args.onChoose} />
			</div>
		</Cache>
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Tim's MacBook" })).toBeInTheDocument();
		await expect(canvas.queryByRole("heading", { name: "Work laptop" })).toBeNull();
	},
});

/** In the desktop app on a computer paired to somebody else: nothing of theirs to choose, and how to pair it. */
export const PickerOnUnpairedComputer = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop])));
		return inDesktopApp("0199a3a0-0000-7000-8000-0000000000ff");
	},
	render: (args) => (
		<Cache>
			<div className="flex max-w-[560px] flex-col gap-6">
				<DeviceAgentPicker chosen={undefined} onChoose={args.onChoose} />
			</div>
		</Cache>
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/This computer isn't paired to you/)).toBeInTheDocument();
		await expect(canvas.queryByRole("button")).toBeNull();
	},
});
