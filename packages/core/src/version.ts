/*
 * Which build this is. The image build sets both variables, so they are fixed
 * for the life of the process; they are read directly rather than through
 * `Config` because MCP and search clients outside Effect name themselves with
 * the version. Empty values, from a build that set neither, count as unset.
 */

/**
 * The release, such as `0.2.0`; `edge` for a published build of main; or
 * `unknown` for any build not given one, such as `bun run dev` or a hosting
 * platform building the Dockerfile from the repository.
 */
export const VERSION = process.env.SUGABOTS_VERSION || "unknown";

/** The commit the build was made from, or null when the build didn't record one. */
export const COMMIT = process.env.SUGABOTS_COMMIT || null;
