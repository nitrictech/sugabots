import { QueryClientProvider } from "@tanstack/react-query";
import { delay, HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { lendingLaptop } from "@/shell/device-story-fixtures.ts";
import { PairDevice } from "./PairDevice.tsx";

/*
 * Where the desktop app sends somebody to approve pairing it: the computer's
 * name and the code it shows, Approve, or why the code no longer works.
 */

const API = import.meta.env.VITE_API_URL;
const CODE = "K7QM-4XTB";

function Cache({ children }: { children: ReactNode }) {
	const [client] = useState(() => createQueryClient());
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const pending = http.get(`${API}/device-pairings/:code`, () =>
	HttpResponse.json({ code: CODE, name: lendingLaptop.name }),
);

const meta = preview.meta({
	title: "Views/PairDevice",
	component: PairDevice,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { code: CODE, onCancel: fn() },
	render: (args) => (
		<Cache>
			<div style={{ height: "100vh" }}>
				<PairDevice {...args} />
			</div>
		</Cache>
	),
});

/** The computer and its code, with the warning to approve only your own. */
export const Waiting = meta.story({
	beforeEach({ msw }) {
		msw.use(pending);
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Pair Tim's MacBook?" }),
		).toBeInTheDocument();
		await expect(canvas.getByText(CODE)).toBeInTheDocument();
		await expect(canvas.getByText(/Only approve if you started pairing/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
		await expect(args.onCancel).toHaveBeenCalled();
	},
});

/** Approving pairs it, and sends them back to the desktop app. */
export const Approved = meta.story({
	beforeEach({ msw }) {
		msw.use(
			pending,
			http.post(`${API}/device-pairings/:code/approve`, () =>
				HttpResponse.json({ ...lendingLaptop, agents: null }),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Approve" }));
		await expect(
			await canvas.findByText("Paired. You can go back to the desktop app."),
		).toBeInTheDocument();
	},
});

/** Still reading the code. */
export const Loading = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/device-pairings/:code`, async () => {
				await delay("infinite");
				return HttpResponse.json({});
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Reading the pairing code…" }),
		).toBeInTheDocument();
	},
});

/** A code past its ten minutes, or never issued: says how to get a new one. */
export const Expired = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/device-pairings/:code`, () =>
				HttpResponse.json(
					{ _tag: "NotFound", message: "That pairing code has expired" },
					{ status: 404 },
				),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "This pairing code has expired" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Carry on without it" })).toBeEnabled();
	},
});

/** Something else went wrong reading the code. */
export const Failed = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/device-pairings/:code`, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "Something went wrong" },
					{ status: 500 },
				),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "This pairing code did not work" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("alert")).toHaveTextContent("Something went wrong");
	},
});
