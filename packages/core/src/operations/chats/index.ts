/**
 * The chats operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { Chats } from "../../chats/chats/chats.ts";
import { Reactions } from "../../chats/reactions/reactions.ts";
import { Files } from "../../files/files.ts";
import { markNestedChatRead } from "./mark-nested-chat-read.ts";
import { markRead } from "./mark-read.ts";
import { openAutomationFeed } from "./open-automation-feed.ts";
import { react } from "./react.ts";
import { removeFile } from "./remove-file.ts";
import { removeWrittenFile } from "./remove-written-file.ts";
import { renameChat } from "./rename-chat.ts";
import { send } from "./send.ts";
import { setResolved } from "./set-resolved.ts";
import { startInterview } from "./start-interview.ts";
import { startProjectChat } from "./start-project-chat.ts";
import { unreact } from "./unreact.ts";
import { uploadFile } from "./upload-file.ts";

export const chatsOperations = {
	"chats.startInterview": startInterview,
	"chats.openAutomationFeed": openAutomationFeed,
	"chats.startProjectChat": startProjectChat,
	"chats.renameChat": renameChat,
	"chats.setResolved": setResolved,
	"chats.markRead": markRead,
	"chats.markNestedChatRead": markNestedChatRead,
	"chats.send": send,
	"chats.uploadFile": uploadFile,
	"chats.removeFile": removeFile,
	"chats.react": react,
	"chats.unreact": unreact,
	"files.remove": removeWrittenFile,
};

/**
 * Over the chat services they give the floor and ask turns of, which
 * `ChatServices.layer` composes with the events they emit.
 */
export const chatsLayer = Layer.mergeAll(
	Chats.layer,
	ChatFiles.layer,
	Reactions.layer,
	Files.layer,
);
