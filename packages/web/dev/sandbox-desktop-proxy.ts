import type { IncomingMessage } from "node:http";
import { request } from "node:http";
import { connect } from "node:net";
import type { Plugin } from "vite";

/**
 * Serves a pod's sandbox desktop viewer (noVNC) on the web app's own origin in
 * development, at `/sandbox-desktop/<host>:<port>/`. The viewer answers plain
 * HTTP on the Docker host's bridge address, which an HTTPS page may not frame
 * or open a websocket to, so its page and its websocket both come through here.
 *
 * Development only, and only to sandbox ports on `OPENSANDBOX_HOST_IP`: nothing
 * here checks who is asking, so it must never be something a deployment runs.
 */
export function sandboxDesktopProxy(): Plugin {
	const allowedHost = process.env.OPENSANDBOX_HOST_IP || "172.17.0.1";

	return {
		name: "sugabots-sandbox-desktop-proxy",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const target = targetOf(req, allowedHost);
				if (!target) return next();
				const upstream = request(
					{
						host: target.host,
						port: target.port,
						path: target.path,
						method: req.method,
						headers: { ...req.headers, host: `${target.host}:${target.port}` },
					},
					(answer) => {
						res.writeHead(answer.statusCode ?? 502, answer.headers);
						answer.pipe(res);
					},
				);
				upstream.on("error", () => {
					res.statusCode = 502;
					res.end("The sandbox desktop did not answer.");
				});
				req.pipe(upstream);
			});

			server.httpServer?.on("upgrade", (req, socket, head) => {
				const target = targetOf(req, allowedHost);
				if (!target) return;
				const upstream = connect(target.port, target.host, () => {
					const headers = Object.entries(req.headers)
						.filter(([name]) => name !== "host")
						.flatMap(([name, value]) =>
							(Array.isArray(value) ? value : [value]).map((one) => `${name}: ${one}`),
						);
					upstream.write(
						[
							`${req.method} ${target.path} HTTP/1.1`,
							`host: ${target.host}:${target.port}`,
							...headers,
							"",
							"",
						].join("\r\n"),
					);
					upstream.write(head);
					upstream.pipe(socket);
					socket.pipe(upstream);
				});
				upstream.on("error", () => socket.destroy());
				socket.on("error", () => upstream.destroy());
			});
		},
	};
}

const PREFIX = /^\/sandbox-desktop\/([^/:]+):(\d{2,5})(\/.*)?$/;

/** Where a request under the prefix is going, or undefined if it isn't one or isn't allowed. */
function targetOf(req: IncomingMessage, allowedHost: string) {
	const match = PREFIX.exec(req.url ?? "");
	if (!match) return undefined;
	const [, host, port, path] = match;
	if (host !== allowedHost) return undefined;
	return { host, port: Number(port), path: path ?? "/" };
}
