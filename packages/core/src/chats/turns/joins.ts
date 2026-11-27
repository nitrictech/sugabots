/**
 * How a message joins a bot's turn rather than get one of its own. Recording
 * it writes a message by id with no proof, so it is not part of the Turns
 * module's entrypoint: within core, only the floor, which proved the poster
 * reaches the chat, calls it. The package does not export this file.
 */

export { recordJoin } from "./store.ts";
