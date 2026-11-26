import type { ApprovalRequest, ToolCallPart } from "@sugabots/contracts";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import { storyChatFor } from "@/story-app.test-support.tsx";

export function storyApproval(call: ToolCallPart): ApprovalRequest {
	const chatId = storyChatFor(growthDesk).id;
	return {
		call,
		bot: {
			kind: "bot",
			id: growthDesk.id,
			name: growthDesk.name,
			handle: growthDesk.handle,
			color: growthDesk.color,
			eyes: growthDesk.eyes,
			shape: "circle",
		},
		projectId: revenue.id,
		chatId,
		rootChatId: chatId,
	};
}
