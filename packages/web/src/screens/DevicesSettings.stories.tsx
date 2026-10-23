import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { expect, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import {
	idleLaptop,
	inDesktopApp,
	lendingLaptop,
	lentInDocs,
	offlineDesktop,
} from "@/shell/device-story-fixtures.ts";
import { DevicesSettings } from "./DevicesSettings.tsx";

/*
 * Your paired computers on your profile: connected or not, what each lends,
 * and unpairing one. Lending and stopping are offered only for the computer
 * the desktop app's window is on.
 */

const API = import.meta.env.VITE_API_URL;

function Cache({ children }: { children: ReactNode }) {
	const [client] = useState(() => createQueryClient());
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The ids the story's unpair requests named. */
let forgotten: string[] = [];
/** The agents the story's stop-lending requests named. */
let stopped: { deviceId: string; url: unknown }[] = [];

const meta = preview.meta({
	title: "Views/DevicesSettings",
	component: DevicesSettings,
	tags: ["ai-generated"],
	render: () => (
		<Cache>
			<div className="max-w-[560px]">
				<DevicesSettings />
			</div>
		</Cache>
	),
});

/** One computer connected and lending agents, one offline; unpairing asks first. */
export const Paired = meta.story({
	beforeEach({ msw }) {
		forgotten = [];
		msw.use(
			http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop, offlineDesktop])),
			http.delete(`${API}/devices/:deviceId`, ({ params }) => {
				forgotten.push(String(params.deviceId));
				return new HttpResponse(null, { status: 204 });
			}),
		);
		return inDesktopApp(lendingLaptop.id);
	},
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByText("Connected")).toBeInTheDocument();
		await expect(canvas.getByText(lentInDocs.workingDirectory)).toBeInTheDocument();
		await expect(canvas.getByText("Offline")).toBeInTheDocument();
		await userEvent.click(canvas.getAllByRole("button", { name: "Unpair" })[1] as HTMLElement);
		const dialog = await screen.findByRole("dialog", { name: "Unpair Studio desktop?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Unpair" }));
		await waitFor(() => expect(forgotten).toEqual([offlineDesktop.id]));
	},
});

/** Stopping an agent asks its computer to stop lending it. */
export const StopLending = meta.story({
	beforeEach({ msw }) {
		stopped = [];
		msw.use(
			http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop])),
			http.post(`${API}/devices/:deviceId/agents/remove`, async ({ params, request }) => {
				const { url } = (await request.json()) as { url: unknown };
				stopped.push({ deviceId: String(params.deviceId), url });
				return new HttpResponse(null, { status: 204 });
			}),
		);
		return inDesktopApp(lendingLaptop.id);
	},
	play: async ({ canvas, userEvent }) => {
		const buttons = await canvas.findAllByRole("button", { name: "Stop lending" });
		await userEvent.click(buttons[1] as HTMLElement);
		await waitFor(() =>
			expect(stopped).toEqual([{ deviceId: lendingLaptop.id, url: lentInDocs.url }]),
		);
	},
});

/** Claude Code found, nothing lent: lending asks the computer, which asks its owner for a folder. */
export const InstalledNothingLent = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/devices`, () => HttpResponse.json([idleLaptop])),
			http.post(`${API}/devices/:deviceId/agents`, () =>
				HttpResponse.json(
					{ _tag: "Conflict", message: "Not lent on that computer." },
					{ status: 409 },
				),
			),
		);
		return inDesktopApp(idleLaptop.id);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Connect" }));
		await expect(await canvas.findByText("Not lent.")).toBeInTheDocument();
	},
});

/**
 * In a plain browser every computer is listed with what it lends, and can be
 * unpaired, but agents are connected and stopped from its desktop app.
 */
export const InBrowser = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop, idleLaptop])));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(lentInDocs.workingDirectory)).toBeInTheDocument();
		await expect(
			canvas.getAllByText("Agents are connected from the Sugabots desktop app on that computer."),
		).toHaveLength(2);
		await expect(canvas.queryByRole("button", { name: "Connect" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Stop lending" })).toBeNull();
		await expect(canvas.getAllByRole("button", { name: "Unpair" })).toHaveLength(2);
	},
});

/** In the desktop app, only its own computer offers connecting and stopping. */
export const OnThisComputer = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/devices`, () => HttpResponse.json([lendingLaptop, idleLaptop])));
		return inDesktopApp(idleLaptop.id);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Work laptop (this computer)" }),
		).toBeInTheDocument();
		await expect(canvas.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
		await expect(canvas.queryByRole("button", { name: "Stop lending" })).toBeNull();
	},
});

/** No computer paired: nothing is drawn. */
export const NonePaired = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${API}/devices`, () => HttpResponse.json([])));
	},
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(canvasElement.querySelector("section")).toBeNull());
	},
});
