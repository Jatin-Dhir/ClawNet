# ClawView

The operator console a ClawNet node serves at its control API address. It talks only to
the node that serves it: same-origin `fetch` calls to `/api/v1` and one event stream
(`GET /api/v1/events`, read with `fetch` so the token can travel in a header). The
contract is `../docs/API.md`.

Dependencies: React 18, three, Vite and its React plugin. Nothing else.

## Build

```sh
cd clawnet/console
npm install
npm run build
```

The build goes to `clawnet/ui/` (gitignored). A running node serves it from there at once,
with no restart: open the URL the node prints (`clawnet ui`, or the `console` lines of
`clawnet devnet`). Until a build exists the node answers a plain-text "not built" page.

The build must stay compatible with the node's Content-Security-Policy (API.md 2.3):
scripts from `'self'` only, so no inline scripts and no CDN. `vite.config.js` turns off
the module-preload polyfill for that reason. three is a separate chunk that loads only
with the topology view.

## Develop

Start a node (or a devnet), then point the dev server at its API address:

```sh
cd clawnet
node bin/clawnet.js devnet --nodes 5 --topology ring
# in another shell, with the console address of one node, without the path and fragment:
cd clawnet/console
CLAWNET_API=http://127.0.0.1:52864 npm run dev        # PowerShell: $env:CLAWNET_API='...'; npm run dev
```

Open `http://127.0.0.1:5173/#token=<that node's token>`. The dev server proxies `/api` to
the node and strips the `Origin` header, which the node would otherwise refuse
(API.md 2.2). Use the built console for anything you want to verify against the CSP.

## How the token reaches the page

The node never writes its token into a page. It prints a URL with the token in the
fragment, `http://127.0.0.1:<port>/#token=<64 hex>`; a fragment is not sent to the server
and does not appear in `Referer`. On load the console (`src/api.js`, `takeToken`):

1. reads `location.hash`; if it holds `token=`, keeps the value in `sessionStorage` under
   `clawnet.token` and immediately calls `history.replaceState(null, '', location.pathname)`
   so the token leaves the address bar and the history entry;
2. otherwise uses the value already in `sessionStorage` (this tab only);
3. otherwise shows a field to paste the token;
4. checks it with `GET /api/v1/status`; on `401` it forgets the token and goes back to 3.

The token is sent only in the `Authorization` header of same-origin requests. It is never
put in `localStorage`, a cookie or a query string.

## Layout of the source

- `src/api.js` token handling, the fetch client, the event-stream reader with resume.
- `src/store.js` the in-page event bus and `useSnapshot`, the snapshot-then-events pattern
  of API.md section 9 (refetch on `stream.gap`, on a restart and when an event cannot be
  applied).
- `src/views/` one file per view: overview, topology, peers, messages, channels, files,
  diagnostics, event log.
- `src/topology/scene.js` the three.js map. Nodes sit on rings by hop count from this
  node; packet events from the stream travel the edges they concern. One InstancedMesh,
  two LineSegments and one Points cloud, so draw calls stay flat as the network grows. The
  loop runs only while something moves and never while the page or the canvas is hidden;
  `dispose()` frees geometries, materials, the texture and the renderer. Without WebGL, or
  after a lost context, the view falls back to a table of the same data.
