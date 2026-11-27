import type { FirstChatMessage, NewMessage } from "@sugabots/contracts";
import type { BrowserContext, Route } from "playwright";
import { WORKSPACE } from "./browser.ts";

/** How long a send's answer waits, so the message's own event reaches the page first. */
const EVENT_LEAD_MILLISECONDS = 500;

/** answerChatWrites lets the showcase stage post the capture browser’s chat messages. */
export async function answerChatWrites(
	context: BrowserContext,
	stage: (args: string[]) => Promise<string>,
) {
	await context.route("**/api/projects/*/chats", async (route) => {
		const request = route.request();
		if (request.method() !== "POST") return route.continue();
		const sent = request.postDataJSON() as FirstChatMessage;
		const botId = await botOfDefaultProject(context, request.url());
		const started = await stage(["start", botId, sent.retryKey, sent.message]);
		await answerAfterEvent(route, started);
	});
	await context.route("**/api/chats/*/messages", async (route) => {
		const request = route.request();
		if (request.method() !== "POST") return route.continue();
		const sent = request.postDataJSON() as NewMessage;
		const chatId = addressedIdOf(request.url());
		const posted = await stage(["send", chatId, sent.retryKey, sent.message]);
		await answerAfterEvent(route, posted);
	});
}

/** The id a `/chats/:id/messages` or `/projects/:id/chats` request names. */
function addressedIdOf(url: string) {
	return new URL(url).pathname.split("/").at(-2) ?? "";
}

/**
 * The bot whose default project a `/projects/:id/chats` request starts a
 * chat in, read from the workspace's bots as the signed-in page would: the
 * stage starts a bot's chat by its bot.
 */
async function botOfDefaultProject(context: BrowserContext, url: string): Promise<string> {
	const projectId = addressedIdOf(url);
	const answer = await context.request.get(
		new URL(`/api/workspaces/${WORKSPACE}/bots`, url).toString(),
	);
	const bots = (await answer.json()) as Array<{ id: string; defaultProjectId: string }>;
	const bot = bots.find((one) => one.defaultProjectId === projectId);
	if (!bot) throw new Error(`No bot has the default project ${projectId}`);
	return bot.id;
}

/**
 * Answers the page's send once the stage's own event, which reaches it through
 * Postgres and the server, has landed: the page drops its copy of the message
 * when this answers, so answering first makes the message vanish for a frame.
 */
async function answerAfterEvent(route: Route, body: string) {
	await new Promise((resolve) => setTimeout(resolve, EVENT_LEAD_MILLISECONDS));
	await route.fulfill({ status: 201, contentType: "application/json", body });
}
