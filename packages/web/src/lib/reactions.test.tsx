import type { Message, MessageReaction } from "@sugabots/contracts";
import { Forbidden } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatQuery } from "@/lib/chat-query.ts";
import { createQueryClient } from "@/lib/query.ts";
import { useReactions } from "@/lib/reactions.ts";
import { chatDetails, sam, triager } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const message: Message = {
	id: "0199a3a0-0000-7000-8000-0000000007a1",
	chatId: "0199a3a0-0000-7000-8000-0000000007a2",
	author: {
		kind: "member",
		id: sam.id,
		name: sam.name,
		email: sam.email,
		handle: "sam",
		image: null,
	},
	status: "complete",
	parts: [{ type: "text", text: "Ship it?" }],
	content: "Ship it?",
	createdAt: "2026-09-18T08:00:00.000Z",
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("reacting to a message", () => {
	it("takes a reaction back when clicked twice before the first click shows", async () => {
		let answerAdd: (reactions: MessageReaction[]) => void = () => {};
		client.api.chats.react.mockReturnValue(
			Effect.promise(() => new Promise<MessageReaction[]>((resolve) => (answerAdd = resolve))),
		);
		client.api.chats.unreact.mockReturnValue(Effect.succeed([]));
		const queries = createQueryClient();
		const { result } = renderHook(() => useReactions(sam), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queries}>{children}</QueryClientProvider>
			),
		});

		// Both from the message as it was drawn, before either click changed it.
		act(() => {
			result.current.toggle(message, "👍");
			result.current.toggle(message, "👍");
		});
		await waitFor(() => expect(client.api.chats.react).toHaveBeenCalledTimes(1));
		act(() =>
			answerAdd([
				{ emoji: "👍", members: [{ id: sam.id, name: sam.name, at: message.createdAt }] },
			]),
		);

		const request = { params: { messageId: message.id, emoji: "👍" } };
		await waitFor(() => expect(client.api.chats.unreact).toHaveBeenCalledWith(request));
		expect(client.api.chats.react).toHaveBeenCalledTimes(1);
		expect(client.api.chats.react).toHaveBeenCalledWith(request);
	});

	it("shows what the server kept when taking back a reaction it just added is refused", async () => {
		const thumbsUp: MessageReaction[] = [
			{ emoji: "👍", members: [{ id: sam.id, name: sam.name, at: message.createdAt }] },
		];
		const withReactions = (reactions: MessageReaction[]) => ({
			...chatDetails(triager),
			messages: [reactions.length > 0 ? { ...message, reactions } : message],
		});
		client.api.chats.get.mockReturnValue(Effect.succeed(withReactions([])));
		client.api.chats.react.mockReturnValue(Effect.succeed(thumbsUp));
		client.api.chats.unreact.mockReturnValue(
			Effect.fail(new Forbidden({ message: userText`Not allowed` })),
		);
		const queries = createQueryClient();
		const { result } = renderHook(
			() => ({
				chat: useQuery(chatQuery(message.chatId)),
				reactions: useReactions(sam),
			}),
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={queries}>{children}</QueryClientProvider>
				),
			},
		);
		await waitFor(() => expect(result.current.chat.isSuccess).toBe(true));
		client.api.chats.get.mockReturnValue(Effect.succeed(withReactions(thumbsUp)));

		// Both from the message as it was drawn, before either click changed it.
		act(() => {
			result.current.reactions.toggle(message, "👍");
			result.current.reactions.toggle(message, "👍");
		});

		await waitFor(() => expect(client.api.chats.unreact).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(result.current.chat.data?.messages[0]?.reactions).toEqual(thumbsUp));
	});
});
