import type { FormAnswer, FormRequest, ToolCallForm, ToolCallPart } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useEffect, useState } from "react";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { FormCard } from "./FormCard.tsx";

const API = import.meta.env.VITE_API_URL as string;
const PHONE = { viewport: { value: "galaxys9", isRotated: false } };

const socialDesk = {
	name: "Social Desk",
	color: "pink" as const,
	face: "dot" as const,
	shape: "circle" as const,
};

/** A bot's drafts to review: each a tick to go ahead with it, then its text to edit. */
const drafts: FormRequest = {
	message: "Here are this week's posts for X. Untick any that shouldn't go out, and edit the rest.",
	requestedSchema: {
		type: "object",
		properties: {
			launch_keep: { type: "boolean", title: "Post the launch announcement", default: true },
			launch_text: {
				type: "string",
				title: "Launch announcement",
				maxLength: 280,
				default:
					"Sugabots 1.4 is out: your bots can now ask you to fill in a form when they need a decision. Try it today.",
			},
			webinar_keep: { type: "boolean", title: "Post the webinar reminder", default: true },
			webinar_text: {
				type: "string",
				title: "Webinar reminder",
				maxLength: 280,
				default: "Join us Thursday at 10am for a live tour of routines and forms.",
			},
		},
	},
};

/** A trip to plan, with a field of each kind. */
const trip: FormRequest = {
	message: "A few details before I book the Lisbon trip.",
	requestedSchema: {
		type: "object",
		properties: {
			cabin: {
				type: "string",
				title: "Cabin",
				oneOf: [
					{ const: "economy", title: "Economy" },
					{ const: "premium", title: "Premium economy" },
					{ const: "business", title: "Business" },
				],
				default: "economy",
			},
			extras: {
				type: "array",
				title: "Extras",
				items: {
					anyOf: [
						{ const: "bag", title: "Checked bag" },
						{ const: "seats", title: "Seats together" },
						{ const: "lounge", title: "Lounge access" },
					],
				},
			},
			travellers: { type: "integer", title: "Travellers", minimum: 1, maximum: 9, default: 3 },
			depart: { type: "string", title: "Leave on", format: "date" },
			notes: {
				type: "string",
				title: "Anything else",
				description: "Dietary needs, accessibility, a preferred airline.",
			},
		},
		required: ["cabin", "travellers", "depart"],
	},
};

function formCall(form: ToolCallForm, over: Partial<ToolCallPart> = {}): ToolCallPart {
	return {
		type: "tool_call",
		id: "0199a3a0-0000-7000-8000-000000000001",
		tool: "ask_form",
		input: form.request,
		output: null,
		status: "awaiting_approval",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-11-10T09:00:00.000Z",
		finishedAt: null,
		approval: { status: "pending", deciders: "thread", decidedByName: null, decidedAt: null },
		form,
		...over,
	};
}

const fieldOrder = (request: FormRequest) => Object.keys(request.requestedSchema.properties);

const open = (request: FormRequest) => {
	const form = { request, fieldOrder: fieldOrder(request), response: null };
	return { call: formCall(form), form };
};

const settled = (request: FormRequest, answer: FormAnswer) => {
	const form: ToolCallForm = {
		request,
		fieldOrder: fieldOrder(request),
		response: { answer, answeredByName: "Sam", answeredAt: "2026-11-10T09:04:00.000Z" },
	};
	const call = formCall(form, {
		status: "completed",
		output: { ...answer, answeredBy: "Sam" },
		finishedAt: "2026-11-10T09:04:01.000Z",
		approval: {
			status: "allowed",
			deciders: "thread",
			decidedByName: "Sam",
			decidedAt: "2026-11-10T09:04:00.000Z",
		},
	});
	return { call, form };
};

/** What the last story to send a form sent. */
let lastSent: unknown;

const meta = preview.meta({
	title: "Product/FormCard",
	component: FormCard,
	tags: ["ai-generated"],
	args: {
		...open(drafts),
		agent: socialDesk,
		threadId: "0199a3a0-0000-7000-8000-0000000000b2",
		podId: "0199a3a0-0000-7000-8000-0000000000b1",
	},
	beforeEach({ msw }) {
		lastSent = undefined;
		msw.use(
			http.post(`${API}/pods/:podId/tool-calls/:toolCallId/form-response`, async ({ request }) => {
				lastSent = await request.json();
				return new HttpResponse(null, { status: 202 });
			}),
		);
	},
	decorators: [
		function WithQueries(Story) {
			const [queryClient] = useState(
				() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
			);
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="mx-auto max-w-[560px] py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/**
 * ReviewingDrafts is a bot handing over drafts to approve: untick one not to
 * post it, edit another, and send.
 */
export const ReviewingDrafts = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("checkbox", { name: "Post the webinar reminder" }));
		const launch = canvas.getByRole("textbox", { name: "Launch announcement (optional)" });
		await userEvent.type(launch, " 🚀");
		await userEvent.click(canvas.getByRole("button", { name: "Send" }));

		await waitFor(() =>
			expect(lastSent).toEqual({
				answer: {
					action: "accept",
					content: {
						launch_keep: true,
						launch_text: expect.stringMatching(/Try it today\. 🚀$/),
						webinar_keep: false,
						webinar_text: "Join us Thursday at 10am for a live tour of routines and forms.",
					},
				},
			}),
		);
	},
});

/** AskingForDetails is a form with a field of each kind, some prefilled and some optional. */
export const AskingForDetails = meta.story({
	args: open(trip),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("radio", { name: "Economy" })).toBeChecked();
		await expect(canvas.getByRole("checkbox", { name: "Lounge access" })).not.toBeChecked();
		await expect(canvas.getByRole("spinbutton", { name: "Travellers" })).toHaveValue(3);
	},
});

/** RequiredLeftEmpty says which fields still need an answer, and sends nothing until they have one. */
export const RequiredLeftEmpty = meta.story({
	args: open(trip),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Send" }));

		await expect(canvas.getByLabelText("Leave on")).toHaveAccessibleDescription(
			"This field is required.",
		);
		await expect(lastSent).toBeUndefined();
	},
});

/** PostTooLong says a draft is over its limit, counting an emoji as one character, and sends nothing. */
export const PostTooLong = meta.story({
	play: async ({ canvas, userEvent }) => {
		const launch = canvas.getByRole("textbox", { name: "Launch announcement (optional)" });
		await userEvent.clear(launch);
		await userEvent.type(launch, `${"🚀".repeat(140)}${"a".repeat(141)}`);
		await expect(canvas.getByText("281/280")).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Send" }));

		await expect(launch).toHaveAccessibleDescription("Must be at most 280 characters.");
		await expect(lastSent).toBeUndefined();
	},
});

/** Declining tells the bot nobody will fill it in. */
export const DecliningIt = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Decline" }));

		await waitFor(() => expect(lastSent).toEqual({ answer: { action: "decline" } }));
	},
});

/** Answered shows what was sent and who sent it, in the order the bot asked. */
export const Answered = meta.story({
	args: settled(trip, {
		action: "accept",
		content: {
			cabin: "premium",
			extras: ["bag", "seats"],
			travellers: 3,
			depart: "2026-11-14",
		},
	}),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Premium economy")).toBeInTheDocument();
		await expect(canvas.getByText("Checked bag, Seats together")).toBeInTheDocument();
		await expect(canvas.getByText("Answered by Sam")).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Send" })).toBeNull();
	},
});

/** Declined says who declined and that the bot carries on without it. */
export const Declined = meta.story({
	args: settled(drafts, { action: "decline" }),
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("Declined by Sam. Social Desk will carry on without it."),
		).toBeInTheDocument();
	},
});

/** NobodyAnswered is a form whose reply ended, cancelled or failed, before anyone answered it. */
export const NobodyAnswered = meta.story({
	args: (() => {
		const form = { request: drafts, fieldOrder: fieldOrder(drafts), response: null };
		return {
			form,
			call: formCall(form, {
				status: "failed",
				error: "The reply was cancelled.",
				finishedAt: "2026-11-10T09:10:00.000Z",
				approval: { status: "denied", deciders: "thread", decidedByName: null, decidedAt: null },
			}),
		};
	})(),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Nobody answered before the reply ended.")).toBeInTheDocument();
	},
});

/** OnAPhone is the drafts to review on a narrow screen, where the card takes the width. */
export const OnAPhone = meta.story({ globals: PHONE });

/** OnAPhoneInLight is the same in the light theme. */
export const OnAPhoneInLight = meta.story({ globals: { ...PHONE, theme: "light" } });
