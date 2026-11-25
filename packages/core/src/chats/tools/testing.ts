import { Effect } from "effect";
import {
	seedBot,
	seedConnector,
	seedMember,
	seedProject,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { botForAskerForTests } from "../../authentication/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";

/** A turn with no computer and no chat files, for cases that only look at connectors' tools. */
const CHAT_ID = "0199a3a0-0000-7000-8000-000000000001";
export const NO_TURN = {
	principal: botForAskerForTests({ turn: "t", chat: CHAT_ID, project: "p" }),
	turnId: "t",
	botId: "a",
	chatId: CHAT_ID,
	files: { read: () => Effect.die(new Error("No chat files in this test")) },
	computer: undefined,
	computerSignsIn: false,
};

export async function catalogReachFixture() {
	const workspace = await seedWorkspace();
	const member = await seedMember(workspace, "editor");
	const lead = await seedBot(workspace);
	const project = await seedProject(workspace, { leadBotId: lead.id, members: [member] });
	const otherProject = await seedProject(workspace, { leadBotId: lead.id, members: [member] });
	const principal = await principals(await authenticators()).member(member);
	return {
		workspace,
		project,
		otherProject,
		side: { ...NO_TURN, principal },
		connector: (projectId = project) => seedConnector(workspace, projectId),
	};
}
