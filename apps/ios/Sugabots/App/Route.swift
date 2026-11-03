import Foundation

/// Every page a tab's stack can push, as the web's phone routes.
enum Route: Hashable {
	/// A pod's first channel, General, opened on first use.
	case podChat(Pod)
	/// A bot's channel in a pod, opened on first use.
	case botChannel(Pod, Agent)
	/// A channel, thread, routine's thread, run or collaboration, by its thread, with the title shown until it loads.
	case conversation(threadId: String, title: String)
	/// A conversation opened at one of its messages, from the Inbox.
	case conversationAt(threadId: String, messageId: String)
	/// A collaboration or a routine's run on its own page, from the Inbox.
	case sideThreadPage(conversationId: String, threadId: String)
	/// A request for approval on its own page, from Approvals.
	case approval(callId: String)
	/// Starting a thread in a pod from its first message, with `agent`, or between people.
	case newThread(Pod, agent: Agent?)
	/// A bot's routines, or every routine in the pod.
	case routines(Pod, agent: Agent?)
	/// Making a routine in a pod, for `agent` when begun from its routines.
	case newRoutine(Pod, agent: Agent?)
	/// A routine's own thread, where its runs post, opened first if it has none.
	case routine(Pod, routineId: String)
	case artifacts(Pod)
	/// One artifact on its own page, at `version`, or its current version when nil.
	case artifact(podId: String, artifactId: String, version: Int?)
	case podSettings(Pod)
	/// A settings page, as the web's `/settings` and `/you` paths name them.
	case settings(SettingsPlace)
}
