/**
 * The services a `clawnet` node runs by default.
 *
 * This is the one place that decides which services the command line (and the devnet
 * launcher) start a node with. `ClawNode` itself imports no service, so a node built by
 * other means, such as a test, chooses its own list.
 */

import { createCastService } from './cast/channels.js';
import { createDiagService } from './core/diag/diag.js';
import { createMessagesService } from './core/messaging/conversations.js';
import { createApiService } from './gate/api-server.js';
import { createFileTransferService } from './vault/file-transfer.js';

/**
 * A fresh list of service instances; every node needs its own, because a service keeps
 * the state of the node it runs in.
 *
 * Order matters in one way: services start in this order and stop in the reverse order,
 * so the control API comes last. It then opens its port only when everything it exposes
 * works, and closes first when the node stops.
 *
 * @param {{ uiDir?: string }} [options] `uiDir`: where the API serves the console from
 * @returns {object[]} Services (ARCHITECTURE.md section 6)
 */
export function defaultServices({ uiDir } = {}) {
  return [
    createMessagesService(),
    createDiagService(),
    // Every node on a real network runs `cast`: it registers the cast dataset, without
    // which the node keeps a relay-only one that never surfaces casts.
    createCastService(),
    createFileTransferService(),
    // ADD NEW SERVICES HERE, before the API: relay, mailbox and the like.
    // Each is one line in the style of the ones above, `createXService()`, importing its
    // factory at the top of this file. Whatever routes a service registers through
    // `ctx.api.route` are served by the API service below without any change to it.
    createApiService(uiDir === undefined ? {} : { uiDir }),
  ];
}
