/*
 * How much the web app's screens show before they offer more, as plain data,
 * which the native apps' copies are generated from. apps/codegen loads this
 * module with Node, so it imports nothing but types.
 */

/** More models than this and a provider's list gets a search and a filter by who makes them. */
export const MODEL_SEARCH_THRESHOLD = 20;

/** How many of a bot's open threads show under it, before the rest are offered. */
export const THREADS_SHOWN = 6;
