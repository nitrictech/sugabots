import type { BrowserContext, Route } from "playwright";
import { expect, it, vi } from "vitest";
import { answerChatWrites } from "../scripts/capture/chat-writes.ts";

const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000001";
const BOT_ID = "0199a3a0-0000-7000-8000-000000000002";
const CHAT_ID = "0199a3a0-0000-7000-8000-000000000003";
const RETRY_KEY = "0199a3a0-0000-7000-8000-000000000004";

it.each([
	["**/api/projects/*/chats", `/api/projects/${PROJECT_ID}/chats`, "start", BOT_ID],
	["**/api/chats/*/messages", `/api/chats/${CHAT_ID}/messages`, "send", CHAT_ID],
])(
	"passes the browser's message retry key to the showcase at %s",
	async (pattern, path, command, id) => {
		const handlers = new Map<string, (route: Route) => Promise<unknown>>();
		const context = {
			route: (pattern: string, handler: (route: Route) => Promise<unknown>) => {
				handlers.set(pattern, handler);
			},
			request: {
				get: () =>
					Promise.resolve({
						json: () => Promise.resolve([{ id: BOT_ID, defaultProjectId: PROJECT_ID }]),
					}),
			},
		};
		const stage = vi.fn(async () => JSON.stringify({ chatId: CHAT_ID }));
		await answerChatWrites(context as unknown as BrowserContext, stage);
		const answer = handlers.get(pattern);
		if (!answer) throw new Error(`No capture handler for ${pattern}`);
		const fulfill = vi.fn();
		const message = "Kestrel Freight was charged twice";

		await answer({
			request: () => ({
				method: () => "POST",
				url: () => `http://localhost${path}`,
				postDataJSON: () => ({ retryKey: RETRY_KEY, message }),
			}),
			fulfill,
		} as unknown as Route);

		expect(stage).toHaveBeenCalledExactlyOnceWith([command, id, RETRY_KEY, message]);
		expect(fulfill).toHaveBeenCalledExactlyOnceWith({
			status: 201,
			contentType: "application/json",
			body: JSON.stringify({ chatId: CHAT_ID }),
		});
	},
);
