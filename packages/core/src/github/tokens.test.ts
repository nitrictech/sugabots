import { createVerify, generateKeyPairSync } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { noDatabase } from "../database/testing.ts";
import type { GithubSecrets } from "./store.ts";
import { githubTokens } from "./tokens.ts";

/**
 * Minting an app's installation tokens against a GitHub stand-in that checks
 * the app's signature and records what each token asked for.
 */
describe("GitHub app installation tokens", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const secrets: GithubSecrets = {
		method: "app",
		apiBaseUrl: "https://api.github.com",
		gitHost: "github.com",
		appId: "123",
		privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
		installationId: "987",
	};

	function standIn() {
		const asked: Array<{ url: string; body: unknown; issuer: unknown }> = [];
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			const [header, payload, signature] = String(headers.authorization)
				.replace("Bearer ", "")
				.split(".");
			const verified = createVerify("RSA-SHA256")
				.update(`${header}.${payload}`)
				.verify(publicKey, Buffer.from(signature ?? "", "base64url"));
			if (!verified) return new Response("{}", { status: 401 });
			asked.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
				issuer: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).iss,
			});
			return Response.json({
				token: `ghs_${asked.length}`,
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
			});
		};
		return { asked, fetch };
	}

	const tokensFor = (github: GithubSecrets | undefined, fetch: typeof globalThis.fetch) =>
		githubTokens({
			github: { secrets: () => Effect.succeed(github) },
			httpClients: { for: () => fetch },
		});

	it("mints a read token for just the pod's repositories, signed as the app", async () => {
		const { asked, fetch } = standIn();
		const tokens = tokensFor(secrets, fetch);

		const credentials = await Effect.runPromise(
			tokens
				.credentialsFor("w", { access: "read", repositories: ["acme/app", "acme/site"] })
				.pipe(Effect.provide(noDatabase)),
		);

		expect(credentials).toMatchObject({ token: "ghs_1", gitHost: "github.com" });
		expect(asked).toEqual([
			{
				url: "https://api.github.com/app/installations/987/access_tokens",
				body: {
					permissions: { contents: "read", metadata: "read" },
					repositories: ["app", "site"],
				},
				issuer: "123",
			},
		]);
	});

	it("reuses a token until it nears expiry, and mints a separate one for writing", async () => {
		const { asked, fetch } = standIn();
		const tokens = tokensFor(secrets, fetch);
		const ask = (access: "read" | "write") =>
			Effect.runPromise(
				tokens
					.credentialsFor("w", { access, repositories: ["acme/app"] })
					.pipe(Effect.provide(noDatabase)),
			);

		await ask("read");
		await ask("read");
		const write = await ask("write");

		expect(asked).toHaveLength(2);
		expect(write?.token).toBe("ghs_2");
		expect(asked[1]?.body).toMatchObject({
			permissions: { contents: "write", pull_requests: "write" },
		});
	});

	it("gives nothing for an app that isn't installed yet", async () => {
		const { asked, fetch } = standIn();
		const tokens = tokensFor({ ...secrets, installationId: null }, fetch);

		expect(
			await Effect.runPromise(
				tokens.credentialsFor("w", { access: "read" }).pipe(Effect.provide(noDatabase)),
			),
		).toBeUndefined();
		expect(asked).toHaveLength(0);
	});
});
