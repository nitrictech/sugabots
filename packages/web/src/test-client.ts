import { vi } from "vitest";

/**
 * A stand-in for `@/api.ts`, and nothing else.
 *
 * Its own module, importing nothing of the app's, because a test file mocks
 * `@/api.ts` with it — and anything this reached for would be pulled in
 * *through* that mock, back into the module graph it is standing outside of.
 * The fixtures and the mounting live in `test-api.tsx`, which is free to
 * import the app because nothing mocks it.
 *
 * The shape mirrors the SDK's generated client: one function per endpoint,
 * grouped as the API definition groups them, each answering with an
 * `Effect`. A case says what an endpoint answers with
 * `mockReturnValue(Effect.succeed(…))`, or `Effect.fail(new NotFound(…))`
 * for a refusal.
 */
export const client = {
	baseUrl: "https://api.test",
	api: {
		health: vi.fn(),
		me: vi.fn(),
		workspaceAccess: vi.fn(),
		workspaces: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			memberships: vi.fn(),
			changeRole: vi.fn(),
			removeMembership: vi.fn(),
			handOverOwnership: vi.fn(),
			leave: vi.fn(),
			invitations: vi.fn(),
			invite: vi.fn(),
			cancelInvitation: vi.fn(),
			invitation: vi.fn(),
			acceptInvitation: vi.fn(),
		},
		bots: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			pin: vi.fn(),
			unpin: vi.fn(),
			ensureAssistant: vi.fn(),
		},
		projects: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			listMembers: vi.fn(),
			listPeople: vi.fn(),
			addMember: vi.fn(),
			removeMember: vi.fn(),
			leave: vi.fn(),
			join: vi.fn(),
			listBots: vi.fn(),
			addBot: vi.fn(),
			removeBot: vi.fn(),
		},
		referrals: {
			link: vi.fn(),
			resetLink: vi.fn(),
		},
		notifications: {
			settings: vi.fn(),
			updatePreferences: vi.fn(),
			setLevel: vi.fn(),
			mute: vi.fn(),
			sendTest: vi.fn(),
			reportPresence: vi.fn(),
		},
		workspaceSetup: {
			complete: vi.fn(),
		},
		systemBots: {
			list: vi.fn(),
			update: vi.fn(),
		},
		modelProviders: {
			list: vi.fn(),
			listEnabledModels: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
			discoverModels: vi.fn(),
			addModel: vi.fn(),
			updateModel: vi.fn(),
			switchOffModel: vi.fn(),
			switchOff: vi.fn(),
		},
		searchProviders: {
			get: vi.fn(),
			webAccess: vi.fn(),
			replace: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
		},
		computerProviders: {
			access: vi.fn(),
		},
		connectors: {
			list: vi.fn(),
			create: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
			testUnsaved: vi.fn(),
			connectBuiltIn: vi.fn(),
			startOAuth: vi.fn(),
		},
		chats: {
			projectChats: vi.fn(),
			attention: vi.fn(),
			attentionMarks: vi.fn(),
			approvals: vi.fn(),
			markRead: vi.fn(),
			markNestedChatRead: vi.fn(),
			startInterview: vi.fn(),
			openAutomationFeed: vi.fn(),
			startProjectChat: vi.fn(),
			markResolved: vi.fn(),
			reopen: vi.fn(),
			messages: vi.fn(),
			history: vi.fn(),
			send: vi.fn(),
			removeFile: vi.fn(),
			get: vi.fn(),
			react: vi.fn(),
			unreact: vi.fn(),
			context: vi.fn(),
		},
		events: {
			workspace: vi.fn(),
			chat: vi.fn(),
			typing: vi.fn(),
		},
		approvals: {
			decide: vi.fn(),
		},
		files: {
			listInProject: vi.fn(),
			get: vi.fn(),
			versions: vi.fn(),
			getVersion: vi.fn(),
			pageAddress: vi.fn(),
			remove: vi.fn(),
		},
		automations: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			run: vi.fn(),
			addTrigger: vi.fn(),
			updateTrigger: vi.fn(),
			removeTrigger: vi.fn(),
			getSecret: vi.fn(),
			rotateSecret: vi.fn(),
			projectRuns: vi.fn(),
		},
	},
	events: { chat: vi.fn(), workspace: vi.fn(), me: vi.fn() },
	auth: {
		signIn: vi.fn(),
		signUp: vi.fn(),
		signOut: vi.fn(),
		updateName: vi.fn(),
	},
};
