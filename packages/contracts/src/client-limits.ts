/*
 * Limits and defaults the apps (the web app and the native ones) draw their
 * screens with, which no API schema checks. They live here, as plain values,
 * so every app reads the same ones: the native apps' copies are generated
 * from this module.
 */

/** How long an invitation link lasts: the auth library's default, which the server keeps. */
export const INVITE_LIFETIME_DAYS = 2;

/** The quiet hours offered when somebody switches them on, in their device's time zone. */
export const DEFAULT_QUIET_HOURS = { from: "22:00", to: "08:00" } as const;

/** More models than this and a provider's list gets a search and a filter by who makes them. */
export const LARGE_MODEL_CATALOG = 20;

/** How many of a bot's open threads show under it, before the rest are offered. */
export const THREADS_SHOWN = 6;
