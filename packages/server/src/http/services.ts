import type { Automations } from "@sugabots/core/chats/automations/automations";
import type { DesktopViewer } from "@sugabots/core/chats/tools/browser/viewer";
import type { FilePages } from "@sugabots/core/files/pages";
import type { Operations } from "@sugabots/core/operations/registry";
import type { StreamAccess } from "../routes/events/access.ts";

/**
 * Everything the routes may ask core for: the operation registry, which a
 * route reaches through `operationCaller`; services of operations or views whose
 * every method requires the current principal and authorizes them, for groups
 * not yet moved onto operations; or the event
 * streams' `StreamAccess`, which does the same for an event stream. The exception
 * is `Automations.ConnectorEvents`, which a GitHub app's delivery runs once
 * core's webhook authenticator has admitted it; and `FilePages`, whose `open`
 * serves a page to whoever holds its address on the content origin.
 *
 * `apiLayer` requires these and nothing else from core, so a route yielding a
 * repository, a workflow's steps or a service that acts for nobody, such as
 * `TurnExecution` or `PersonalAssistants`, does not compile.
 */
export type HttpServices =
	| Operations.Service
	| DesktopViewer.Service
	| FilePages.Service
	| Automations.ConnectorEvents
	| StreamAccess.Service;
