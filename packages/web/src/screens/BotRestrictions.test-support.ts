import type { Bot } from "@sugabots/contracts";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";

export const personalBot: Bot = {
	...growthDesk,
	id: "0199a3a0-0000-7000-8000-000000000181",
	defaultProjectId: "0199a3a0-0000-7000-8000-000000000281",
	name: "Drafting Desk",
	handle: "drafting-desk",
	visibility: "personal",
	pinned: false,
	permissions: {
		update: false,
		delete: true,
		talk: false,
		resources: {
			openSettings: true,
			readHistory: false,
			resolveChats: false,
			deleteFiles: false,
			manageConnectors: false,
			manageComputer: false,
			useDesktop: false,
			manageAutomations: false,
			pauseAutomations: true,
			runAutomations: false,
		},
	},
};
