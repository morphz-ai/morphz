import type { CDPSession } from "@playwright/test";

/** Read-only, bounded evidence retention for actual Document replacement. */
export async function retainCognitiveNetworkResponses(network: CDPSession) {
  await network.send("Network.enable");
  await network.send("Network.configureDurableMessages", {
    maxTotalBufferSize: 16 * 1024 * 1024,
    maxResourceBufferSize: 4 * 1024 * 1024,
  });
}
