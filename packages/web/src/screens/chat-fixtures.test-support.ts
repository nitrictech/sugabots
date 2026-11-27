import type { ChatDetails, ProjectChat } from "@sugabots/contracts";
import { testMember } from "@sugabots/contracts/testing";

export const robin = testMember({
	id: "0199a3a0-0000-7000-8000-000000000501",
	name: "Robin Vale",
});

type DetailsOverrides = Partial<Omit<ChatDetails, "chat">> & {
	chat?: Partial<ChatDetails["chat"]>;
};

export function chatDetailsFixture(
	chat: ProjectChat,
	{ chat: chatDefaults, ...defaults }: DetailsOverrides,
) {
	return ({ chat: changes, ...overrides }: DetailsOverrides = {}): ChatDetails => ({
		automationRun: null,
		participants: [],
		projectBots: [],
		membersReachingProject: [],
		messages: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		...defaults,
		...overrides,
		chat: {
			...chat,
			rootChatId: chat.id,
			working: false,
			...chatDefaults,
			...changes,
		},
	});
}
