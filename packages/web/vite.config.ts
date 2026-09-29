import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		// The logo and icons belong to `@sugabots/avatars`. `index.html` cannot
		// import from a package, so they are copied to the root instead.
		viteStaticCopy({
			targets: [
				{
					src: avatarsAsset("sugabots-logo.svg"),
					dest: ".",
					rename: { stripBase: true, name: "favicon.svg" },
				},
				{ src: avatarsAsset("app-icons/*"), dest: ".", rename: { stripBase: true } },
			],
		}),
	],
	// One .env for the whole workspace, next to compose.yml, rather than one per
	// app. The API and the tests read the same file.
	envDir: "../..",
	resolve: {
		// `@/` is what shadcn/ui generates against; the tsconfig `paths` and the
		// Vitest `web` project have to agree with this.
		alias: { "@": new URL("./src/", import.meta.url).pathname },
	},
	server: {
		// Portless passes both. $HOST matters: Vite otherwise resolves
		// "localhost" to IPv6 ::1, which the IPv4 proxy cannot reach — a dev
		// server that is up and a browser that says connection refused.
		port: Number(process.env.PORT) || 5173,
		host: process.env.HOST || "localhost",
		// The API, on the same origin as far as the browser knows. Portless gives
		// the API process an ephemeral port, so this goes to its name. The scheme
		// has to be https: Portless answers port 80 with a redirect to its https
		// name, which Vite passes to the browser, and the browser then leaves this
		// origin and is refused by CORS. `changeOrigin` rewrites the Host header,
		// without which Portless routes the request straight back here.
		proxy: {
			"/api": {
				target: process.env.API_URL || "https://api.sugabots.localhost",
				changeOrigin: true,
			},
		},
	},
});

/**
 * A file `@sugabots/avatars` exports, as a path the copy plugin's globbing
 * accepts: forward slashes, even on Windows.
 */
function avatarsAsset(exportPath: string): string {
	return normalizePath(fileURLToPath(import.meta.resolve(`@sugabots/avatars/${exportPath}`)));
}
