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
	api: {
		health: vi.fn(),
		me: vi.fn(),
		workspaceAccess: vi.fn(),
		workspaces: {
			list: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			members: vi.fn(),
			updateMember: vi.fn(),
			removeMember: vi.fn(),
			transferOwnership: vi.fn(),
			leave: vi.fn(),
			invitations: vi.fn(),
			invite: vi.fn(),
			cancelInvitation: vi.fn(),
			invitation: vi.fn(),
			acceptInvitation: vi.fn(),
		},
		agents: {
			list: vi.fn(),
			create: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		},
		pods: {
			list: vi.fn(),
			create: vi.fn(),
			ensurePersonal: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			listMembers: vi.fn(),
			addMember: vi.fn(),
			removeMember: vi.fn(),
			leave: vi.fn(),
		},
		referrals: {
			link: vi.fn(),
			resetLink: vi.fn(),
		},
		onboarding: {
			status: vi.fn(),
			complete: vi.fn(),
			completeInvite: vi.fn(),
		},
		systemAgents: {
			list: vi.fn(),
			update: vi.fn(),
		},
		modelTrials: {
			run: vi.fn(),
		},
		modelProviders: {
			list: vi.fn(),
			listEnabledModels: vi.fn(),
			create: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
			fetchModels: vi.fn(),
			addModel: vi.fn(),
			setModelsEnabled: vi.fn(),
			updateModel: vi.fn(),
			removeModel: vi.fn(),
		},
		searchProviders: {
			get: vi.fn(),
			webAccess: vi.fn(),
			replace: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
		},
		connections: {
			list: vi.fn(),
			create: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			test: vi.fn(),
			connectFromCatalog: vi.fn(),
			startOAuth: vi.fn(),
		},
		chats: {
			list: vi.fn(),
			podMarkers: vi.fn(),
			markRead: vi.fn(),
			getOrCreate: vi.fn(),
			messages: vi.fn(),
			history: vi.fn(),
			send: vi.fn(),
		},
		events: {
			workspace: vi.fn(),
			thread: vi.fn(),
			typing: vi.fn(),
		},
		threads: {
			list: vi.fn(),
			get: vi.fn(),
			activity: vi.fn(),
			cancelTurn: vi.fn(),
		},
		toolApprovals: {
			decide: vi.fn(),
		},
		routines: {
			listInWorkspace: vi.fn(),
			list: vi.fn(),
			create: vi.fn(),
			previewSchedule: vi.fn(),
			get: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			run: vi.fn(),
			rotateSecret: vi.fn(),
			executions: vi.fn(),
		},
	},
	events: { thread: vi.fn(), workspace: vi.fn() },
	tokens: { get: vi.fn(), set: vi.fn() },
	auth: {
		signIn: vi.fn(),
		signUp: vi.fn(),
		signOut: vi.fn(),
		updateName: vi.fn(),
	},
};
