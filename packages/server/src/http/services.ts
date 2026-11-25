import type { Operations } from "@sugabots/core/operations/registry";

/**
 * Everything the routes may ask core for: the operation registry, which a
 * route reaches through `operationCaller`, and its long-running operations,
 * the event streams and the desktop viewer, which a route reaches through
 * `longRunningCaller` or, for the viewer's WebSocket, directly.
 *
 * `apiLayer` requires these and nothing else from core, so a route yielding a
 * repository, a workflow's steps or a service that acts for nobody, such as
 * `TurnExecution` or `PersonalAssistants`, does not compile.
 */
export type HttpServices = Operations.Service | Operations.LongRunning;
