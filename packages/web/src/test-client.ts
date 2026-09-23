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
 * The shape mirrors the Hono RPC client: one function per route and method,
 * so a route added to the API chain shows up here as a missing key rather
 * than as a runtime surprise.
 */
export const client = {
	api: {
		me: { $get: vi.fn() },
		onboarding: {
			$get: vi.fn(),
			complete: { $post: vi.fn() },
			"complete-invite": { $post: vi.fn() },
		},
		workspaces: {
			":workspaceId": {
				me: { $get: vi.fn() },
				pods: { $get: vi.fn(), $post: vi.fn() },
				agents: { $get: vi.fn() },
				"system-agents": { $get: vi.fn(), ":key": { $patch: vi.fn() } },
				"personal-pod": { $post: vi.fn() },
				threads: { $get: vi.fn() },
				chats: { $post: vi.fn() },
				"model-trials": { $post: vi.fn() },
				"search-provider": {
					$get: vi.fn(),
					$put: vi.fn(),
					$patch: vi.fn(),
					$delete: vi.fn(),
					test: { $post: vi.fn() },
				},
				"model-providers": {
					$get: vi.fn(),
					$post: vi.fn(),
					models: { $get: vi.fn() },
					":providerId": {
						$get: vi.fn(),
						$patch: vi.fn(),
						$delete: vi.fn(),
						test: { $post: vi.fn() },
						"fetch-models": { $post: vi.fn() },
						models: {
							$post: vi.fn(),
							$patch: vi.fn(),
							":modelId": { $patch: vi.fn(), $delete: vi.fn() },
						},
					},
				},
			},
		},
		threads: { ":threadId": { $get: vi.fn() } },
		chats: {
			":chatId": {
				messages: { $get: vi.fn(), $post: vi.fn() },
				history: { $get: vi.fn() },
			},
		},
		pods: {
			":podId": {
				$patch: vi.fn(),
				$delete: vi.fn(),
				agents: { $post: vi.fn() },
				members: { $get: vi.fn(), $post: vi.fn(), ":userId": { $delete: vi.fn() } },
				connections: {
					$get: vi.fn(),
					$post: vi.fn(),
					connect: { $post: vi.fn() },
					":connectionId": {
						$get: vi.fn(),
						$patch: vi.fn(),
						$delete: vi.fn(),
						test: { $post: vi.fn() },
						oauth: { start: { $post: vi.fn() } },
					},
				},
				"tool-calls": {
					":toolCallId": { approval: { $post: vi.fn() } },
				},
				"tool-approval-rules": {
					$get: vi.fn(),
					":ruleId": { $delete: vi.fn() },
				},
			},
		},
		turns: { ":turnId": { cancel: { $post: vi.fn() } } },
		agents: {
			":agentId": {
				$get: vi.fn(),
				$patch: vi.fn(),
				$delete: vi.fn(),
				routines: {
					$get: vi.fn(),
					$post: vi.fn(),
					"schedule-preview": { $post: vi.fn() },
					":routineId": {
						$get: vi.fn(),
						$patch: vi.fn(),
						$delete: vi.fn(),
						run: { $post: vi.fn() },
						secret: { $post: vi.fn() },
						executions: { $get: vi.fn() },
					},
				},
			},
		},
	},
	events: { thread: vi.fn(), workspace: vi.fn() },
	tokens: { get: vi.fn(), set: vi.fn() },
	auth: {
		signIn: vi.fn(),
		signUp: vi.fn(),
		signOut: vi.fn(),
		workspaces: {
			list: vi.fn(),
			members: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateRole: vi.fn(),
			removeMember: vi.fn(),
			invitations: vi.fn(),
			cancelInvite: vi.fn(),
			leave: vi.fn(),
			invite: vi.fn(),
			invitation: vi.fn(),
			acceptInvite: vi.fn(),
		},
	},
};
