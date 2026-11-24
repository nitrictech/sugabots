import { Effect } from "effect";

/** A turn with no computer and no chat files, for cases that only look at connectors' tools. */
export const NO_TURN = {
	turnId: "t",
	botId: "a",
	chatId: "0199a3a0-0000-7000-8000-000000000001",
	files: { read: () => Effect.die(new Error("No chat files in this test")) },
	computer: undefined,
	computerSignsIn: false,
};
