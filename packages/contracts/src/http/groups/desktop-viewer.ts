import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { uuidOrStringSchema } from "../../uuid.ts";

/**
 * A bot's desktop in a chat, live: the WebSocket the web app's desktop viewer
 * opens. The server serves it with a route of its own, outside `Api`, because
 * the request becomes a WebSocket. Its path is relative to `API_BASE_PATH`.
 */
export const desktopViewerEndpoint = HttpApiEndpoint.get(
	"open",
	"/chats/:chatId/bots/:botId/desktop",
	{ params: { chatId: uuidOrStringSchema, botId: uuidOrStringSchema } },
);

/** The desktop viewer's endpoint as an API of its own, so a client builds its URL from it. */
export class DesktopViewerApi extends HttpApi.make("desktopViewer").add(
	HttpApiGroup.make("desktopViewer").add(desktopViewerEndpoint),
) {}
