# Sugabots sandboxes on Cloudflare

A Worker that makes and runs pods' sandboxes in a Cloudflare account, for the
Cloudflare sandbox provider. Cloudflare's sandboxes are Durable Objects with a
container each, which only a Worker can reach, so a workspace deploys this one
to its own account and Sugabots calls it over HTTP. `src/index.ts` lists its API.

## Deploy

Containers need the Workers Paid plan, and Docker to build the image.

```sh
cd packages/cloudflare-sandbox
npx wrangler login
openssl rand -hex 32 | npx wrangler secret put API_KEY
npx wrangler deploy
```

Then, in the workspace's settings under Sandboxes, choose Cloudflare and give
the Worker's address and the same `API_KEY`.

The image is Sugabots' sandbox image, built into the account when the Worker is
deployed. To move new sandboxes to a newer release, pull it and deploy again:

```sh
docker pull ghcr.io/nitrictech/sugabots-sandbox:latest
npx wrangler deploy
```

Pods' sandboxes then offer an upgrade, which copies their work across.

## How it behaves

- **Pausing.** Cloudflare can't pause a container. The Worker snapshots its
  disk and stops it, and opening it starts a new container from the snapshot:
  files survive, programs don't. Container snapshots are in beta, and expire
  30 days after they're made.
- **Idle sandboxes.** Sugabots pauses idle sandboxes itself. If it doesn't, a
  sandbox pauses after 30 minutes without a request.
- **Lost sandboxes.** A container that stops without a pause, such as when its
  host fails, loses its disk. Sugabots makes the pod a new one.
- **Network.** Sandboxes start without the internet. HTTP and HTTPS requests
  go through the Worker, which lets through only the hosts the pod's sandbox is
  allowed, and HTTPS is signed by an authority the container trusts. Other
  ports can't leave.

## Develop

```sh
echo API_KEY=local-dev-key > .dev.vars
npx wrangler dev --port 8788
```

`wrangler dev` runs the containers on the local Docker, snapshots included. On
systems where workerd can't find the CA bundle, such as NixOS, set
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`.

The provider tests in `packages/core/src/sandboxes/sandboxes.test.ts` run
against it from the repository root:

```sh
CLOUDFLARE_SANDBOX_URL=http://127.0.0.1:8788 CLOUDFLARE_SANDBOX_API_KEY=local-dev-key \
  npx vitest run --project backend packages/core/src/sandboxes/sandboxes.test.ts
```
