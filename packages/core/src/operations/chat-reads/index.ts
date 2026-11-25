/**
 * The chat-reads operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Layer } from "effect";
import { ChatDetailsView } from "../../chats/chat-details-view.ts";
import { ChatFiles } from "../../chats/chats/chat-files.ts";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { Files } from "../../files/files.ts";
import { FilePages } from "../../files/pages.ts";
import { approvals } from "./approvals.ts";
import { attention } from "./attention.ts";
import { attentionMarks } from "./attention-marks.ts";
import { chatFile } from "./chat-file.ts";
import { context } from "./context.ts";
import { fileVersion } from "./file-version.ts";
import { fileVersions } from "./file-versions.ts";
import { get } from "./get.ts";
import { history } from "./history.ts";
import { listFilesInProject } from "./list-files-in-project.ts";
import { messages } from "./messages.ts";
import { pageAddress } from "./page-address.ts";
import { projectChats } from "./project-chats.ts";
import { readChatFile } from "./read-chat-file.ts";
import { readDocs } from "./read-docs.ts";
import { searchHistory } from "./search-history.ts";
import { workspaceRole } from "./workspace-role.ts";
import { writtenFile } from "./written-file.ts";

export const chatReadsOperations = {
	"chats.searchHistory": searchHistory,
	"chats.readChatFile": readChatFile,
	"chats.readDocs": readDocs,
	"chats.workspaceRole": workspaceRole,
	"chats.projectChats": projectChats,
	"chats.attention": attention,
	"chats.attentionMarks": attentionMarks,
	"chats.approvals": approvals,
	"chats.messages": messages,
	"chats.history": history,
	"chats.file": chatFile,
	"chats.get": get,
	"chats.context": context,
	"files.listInProject": listFilesInProject,
	"files.get": writtenFile,
	"files.versions": fileVersions,
	"files.getVersion": fileVersion,
	"files.pageAddress": pageAddress,
};

export const chatReadsLayer = Layer.mergeAll(
	ChatView.layer,
	ChatDetailsView.layer,
	ChatFiles.layer,
	Files.layer,
	FilePages.layer,
);
