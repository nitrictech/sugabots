import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { expect, fn, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { McpApps } from "./McpAppFrame.tsx";

const API = import.meta.env.VITE_API_URL as string;

const looks = new Map<string, ConnectionLook>([["weather", { name: "Weather" }]]);

/**
 * A stand-in MCP App that speaks the protocol by hand. Given the call's
 * result, it shows it, asks its server for a fresh one through the host,
 * and grows to `REFRESHED_HEIGHT_PX` once that arrives, which is what the
 * story can see of a frame whose insides are another origin's.
 */
const REFRESHED_HEIGHT_PX = 200;

const WEATHER_APP_HTML = `<!doctype html><html><body style="margin:0;padding:12px;font-family:sans-serif;color:#888">
<p id="forecast" style="margin:0">Waiting for the forecast</p>
<script>
let lastId = 0;
const waiting = new Map();
const send = (message) => parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
const request = (method, params) => new Promise((resolve) => {
	lastId += 1;
	waiting.set(lastId, resolve);
	send({ id: lastId, method, params });
});
const show = (result) => { forecast.textContent = "Forecast: " + result.content[0].text; };
addEventListener("message", ({ data }) => {
	if (data.id !== undefined && waiting.has(data.id)) {
		waiting.get(data.id)(data.result);
		waiting.delete(data.id);
	} else if (data.method === "ui/notifications/tool-result") {
		show(data.params);
		request("tools/call", { name: "refresh", arguments: {} }).then((fresh) => {
			show(fresh);
			send({ method: "ui/notifications/size-changed", params: { height: ${REFRESHED_HEIGHT_PX} } });
		});
	}
});
request("ui/initialize", { appInfo: { name: "weather", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
	.then(() => send({ method: "ui/notifications/initialized" }));
</script></body></html>`;

function forecastCall(id: string): ToolCallPart {
	return {
		type: "tool_call",
		id,
		tool: "weather__forecast",
		input: { city: "Wellington" },
		output: { content: [{ type: "text", text: "sunny, 18°C" }] },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-25T06:04:00.000Z",
		finishedAt: "2026-09-25T06:04:01.300Z",
		hasApp: true,
	};
}

const earlier = forecastCall("0199a3a0-0000-7000-8000-000000000401");
const latest = forecastCall("0199a3a0-0000-7000-8000-000000000402");
const appCalls: unknown[] = [];

const meta = preview.meta({
	title: "Product/McpApps",
	component: McpApps,
	tags: ["ai-generated"],
	args: {
		calls: [latest],
		looks,
		botName: "Sketch",
		shown: {
			liveCallId: latest.id,
			stagedCallId: undefined,
			onOpen: fn(),
			onAskToDescribe: fn(),
		},
	},
	decorators: [
		(Story) => (
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<div className="max-w-[720px] pl-[50px]">
					<Story />
				</div>
			</QueryClientProvider>
		),
	],
	beforeEach({ msw }) {
		appCalls.length = 0;
		msw.use(
			http.get(`${API}/tool-calls/:id/app`, () =>
				HttpResponse.json({
					html: WEATHER_APP_HTML,
					csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
					prefersBorder: true,
				}),
			),
			http.post(`${API}/tool-calls/:id/app/calls`, async ({ request }) => {
				appCalls.push(await request.json());
				return HttpResponse.json({ content: [{ type: "text", text: "windy, 14°C" }] });
			}),
		);
	},
});

/**
 * The latest app in a chat runs in a card saying whose it is. It is given
 * the call's result and can call its server back through the API.
 */
export const Live = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		const frame = await canvas.findByTitle("weather__forecast app");
		await waitFor(() => expect(frame).toHaveStyle({ height: `${REFRESHED_HEIGHT_PX}px` }), {
			timeout: 5_000,
		});
		await expect(appCalls).toEqual([{ name: "refresh", arguments: {} }]);
		await userEvent.click(canvas.getByRole("button", { name: "Open beside chat" }));
		await expect(args.shown?.onOpen).toHaveBeenCalledWith(latest.id);
	},
});

/** Earlier apps fold to a row, and the one open beside the chat says so instead of running twice. */
export const Folded = meta.story({
	args: {
		calls: [earlier, latest],
		shown: {
			liveCallId: undefined,
			stagedCallId: latest.id,
			onOpen: fn(),
		},
	},
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("Open on the right")).toBeVisible();
		await expect(canvas.queryByTitle("weather__forecast app")).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Open Weather" }));
		await expect(args.shown?.onOpen).toHaveBeenCalledWith(earlier.id);
	},
});

/** An app whose server can't be reached says so, with a way to retry or have the bot put it in words. */
export const DidNotOpen = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/tool-calls/:id/app`, () =>
				HttpResponse.json({ _tag: "NotFound", message: "Unavailable" }, { status: 404 }),
			),
		);
	},
	play: async ({ canvas, args, userEvent }) => {
		await expect(await canvas.findByText("This app didn't open")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Ask Sketch to describe it" }));
		await expect(args.shown?.onAskToDescribe).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Weather", botName: "Sketch" }),
		);
	},
});
