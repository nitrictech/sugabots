import { botParticipantOf, type Message, type MessageReplyTo } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { testMember } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linear, pendingAnswer, sam, triager } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { FakeRequest, stubAttachmentUploads } from "@/lib/attachment-upload.test-support.ts";
import { useChatDraft, useReplyDraft } from "@/lib/chat-draft.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { InRoute } from "@/lib/route.test-support.tsx";
import { useChatRecipients } from "./chat-recipients.ts";
import { useMessageSending } from "./message-sending.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const chatId = "0199a3a0-0000-7000-8000-0000000000e1";

/** The project's bots, between which the member chooses who a message goes to. */
const projectBots = [botParticipantOf(triager), botParticipantOf(linear)];

/** Sam's message in the chat, sent to `bot`, which the next one goes to unless taken off. */
function samsMessageTo(bot: { id: string; handle: string }): Message {
	const content = `@${bot.handle} Have a look`;
	return {
		id: `0199a3a0-0000-7000-8000-${bot.id.slice(-12)}`,
		chatId,
		author: testMember({ id: sam.id, name: sam.name }),
		status: "complete",
		parts: [{ type: "text", text: content }],
		content,
		createdAt: "2026-09-18T09:00:00.000Z",
	};
}

/**
 * A composer on the chat, as the chat's pane puts one together: who the
 * message goes to, from what it names and who Sam's last message went to,
 * and sending it.
 */
function useComposer() {
	const [draft, setDraft] = useChatDraft(sam.id, chatId);
	const [replyingTo, setReplyingTo] = useReplyDraft(sam.id, chatId);
	const [shownMessages, setShownMessages] = useState<Message[]>([]);
	const attachments = useComposerAttachments(chatId);
	const recipients = useChatRecipients({
		memberId: sam.id,
		chatId,
		choosesBots: true,
		projectBots,
		shownMessages,
		draft,
		setDraft,
		replyingTo,
	});
	const sending = useMessageSending({
		chatId,
		signedIn: sam,
		draft,
		setDraft,
		replyingTo,
		setReplyingTo,
		attachments,
		recipients,
		scrollToLatest: () => {},
	});
	return {
		draft,
		setDraft,
		replyingTo,
		setReplyingTo,
		setShownMessages,
		recipients,
		attachments,
		sending,
	};
}

type Composer = { current: ReturnType<typeof useComposer> };

/** Attaches a file named `name` and lets the API accept it as `id`. */
async function attachUploaded(composer: Composer, name: string, id: string) {
	const file = new File(["%PDF"], name, { type: "application/pdf" });
	act(() => composer.current.attachments.attach([file]));
	act(() =>
		FakeRequest.made.at(-1)?.answer(201, { id, name, contentType: file.type, size: file.size }),
	);
	await act(async () => {});
}

/** What the API was asked to send, in order. */
const sentPayloads = () =>
	client.api.chats.send.mock.calls.map(
		([request]) => (request as { payload: Record<string, unknown> }).payload,
	);

const quoted: MessageReplyTo = {
	id: "0199a3a0-0000-7000-8000-0000000000f2",
	author: testMember({ id: sam.id, name: sam.name }),
	preview: "Can you check the release?",
};

beforeEach(() => {
	localStorage.clear();
	stubAttachmentUploads();
	client.api.chats.removeFile.mockReturnValue(Effect.void);
	client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.chats.history.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("a message that is not sent", () => {
	it("comes back whole once the composer is empty, mixing in nothing written meanwhile", async () => {
		const first = pendingAnswer();
		client.api.chats.send.mockReturnValueOnce(first.effect as never);
		const { result } = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(result.current).not.toBeNull());
		await attachUploaded(result, "first.pdf", "0199a3a0-0000-7000-8000-0000000000a1");
		act(() => {
			result.current.setDraft("First thought");
			result.current.setReplyingTo(quoted);
		});
		act(() => void result.current.sending.submit());
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalledTimes(1));

		// Written while the first is on its way.
		act(() => result.current.setDraft("Second thought"));
		await attachUploaded(result, "second.pdf", "0199a3a0-0000-7000-8000-0000000000a2");
		await act(async () => {
			first.answer(Effect.fail(new InternalServerError({ message: userText`Nope` })));
		});

		expect(result.current.draft).toBe("Second thought");
		expect(result.current.replyingTo).toBeUndefined();
		expect(result.current.attachments.items.map(({ file }) => file.name)).toEqual(["second.pdf"]);
		expect(result.current.sending.error).toBe(
			"Message not sent. It comes back here once you send or clear what you're writing.",
		);

		client.api.chats.send.mockReturnValue(Effect.succeed({}) as never);
		await act(() => result.current.sending.submit());

		await waitFor(() => expect(result.current.draft).toBe("First thought"));
		expect(result.current.replyingTo).toEqual(quoted);
		expect(result.current.attachments.items.map(({ file }) => file.name)).toEqual(["first.pdf"]);
		expect(result.current.sending.error).toBe("Message not sent. Your draft is still here.");

		await act(() => result.current.sending.submit());
		const [firstSent, secondSent, firstAgain] = sentPayloads();
		expect(secondSent).toMatchObject({
			message: "Second thought",
			attachments: ["0199a3a0-0000-7000-8000-0000000000a2"],
		});
		expect(secondSent).not.toHaveProperty("replyTo");
		expect(firstSent).toMatchObject({
			message: "First thought",
			replyTo: quoted.id,
			attachments: ["0199a3a0-0000-7000-8000-0000000000a1"],
		});
		expect(firstAgain).toEqual(firstSent);
	});
});

describe("a message not sent, sent again unchanged", () => {
	const failed = () =>
		client.api.chats.send.mockReturnValueOnce(
			Effect.fail(new InternalServerError({ message: userText`Nope` })) as never,
		);

	it("goes to the bots it first went to, under its retry key, though the member's last message changed", async () => {
		failed();
		const { result } = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(result.current).not.toBeNull());
		act(() => {
			result.current.setShownMessages([samsMessageTo(triager)]);
			result.current.setDraft("Check the release");
		});
		await act(() => result.current.sending.submit());
		await waitFor(() => expect(result.current.draft).toBe("Check the release"));

		// Another message of theirs, sent from elsewhere, went to another bot.
		act(() => result.current.setShownMessages([samsMessageTo(linear)]));
		expect(result.current.recipients.addressed.map(({ handle }) => handle)).toEqual([
			triager.handle,
		]);
		client.api.chats.send.mockReturnValue(Effect.succeed({}) as never);
		await act(() => result.current.sending.submit());

		const [first, again] = sentPayloads();
		expect(first).toMatchObject({ message: `@${triager.handle} Check the release` });
		expect(again).toEqual(first);
	});

	it("comes back with its quote, bots and retry key after the chat is left and opened again", async () => {
		failed();
		const first = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(first.result.current).not.toBeNull());
		act(() => {
			first.result.current.setShownMessages([samsMessageTo(triager)]);
			first.result.current.setDraft("Check the release");
			first.result.current.setReplyingTo(quoted);
		});
		await act(() => first.result.current.sending.submit());
		await waitFor(() => expect(first.result.current.draft).toBe("Check the release"));
		first.unmount();

		const { result } = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(result.current?.draft).toBe("Check the release"));
		expect(result.current.replyingTo).toEqual(quoted);
		client.api.chats.send.mockReturnValue(Effect.succeed({}) as never);
		await act(() => result.current.sending.submit());

		const [sent, again] = sentPayloads();
		expect(again).toEqual(sent);
	});

	it("goes to the bots the member leaves on it, under a new key, once they take one off", async () => {
		failed();
		const { result } = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(result.current).not.toBeNull());
		act(() => {
			result.current.setShownMessages([samsMessageTo(triager)]);
			result.current.setDraft("Check the release");
		});
		await act(() => result.current.sending.submit());
		await waitFor(() => expect(result.current.draft).toBe("Check the release"));

		act(() => result.current.recipients.remove(botParticipantOf(triager)));
		expect(result.current.recipients.answering).toEqual([]);
		client.api.chats.send.mockReturnValue(Effect.succeed({}) as never);
		await act(() => result.current.sending.submit());

		const [first, again] = sentPayloads();
		expect(again).toMatchObject({ message: "Check the release" });
		expect(again?.retryKey).not.toBe(first?.retryKey);
	});
});

describe("a message whose sending answers after the chat was left", () => {
	async function sendThenLeave(text: string) {
		const answer = pendingAnswer();
		client.api.chats.send.mockReturnValueOnce(answer.effect as never);
		const left = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(left.result.current).not.toBeNull());
		act(() => {
			left.result.current.setDraft(text);
			left.result.current.setReplyingTo(quoted);
		});
		act(() => void left.result.current.sending.submit());
		await waitFor(() => expect(client.api.chats.send).toHaveBeenCalledTimes(1));
		left.unmount();
		return answer;
	}

	it("comes back to the composer, quote and all, when it was not sent", async () => {
		const answer = await sendThenLeave("Sent on the way out");
		await act(async () => {
			answer.answer(Effect.fail(new InternalServerError({ message: userText`Nope` })));
		});

		const { result } = renderHook(useComposer, { wrapper: InRoute });

		await waitFor(() => expect(result.current?.draft).toBe("Sent on the way out"));
		expect(result.current.replyingTo).toEqual(quoted);
	});

	it("does not come back when it was sent", async () => {
		const answer = await sendThenLeave("Sent on the way out");
		await act(async () => {
			answer.answer(Effect.succeed({}));
		});

		const { result } = renderHook(useComposer, { wrapper: InRoute });
		await waitFor(() => expect(result.current).not.toBeNull());
		await act(async () => {});

		expect(result.current.draft).toBe("");
		expect(result.current.sending.error).toBeUndefined();
	});
});
