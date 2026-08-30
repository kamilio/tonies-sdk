import { createSDK } from "toolcraft/sdk";
import { root } from "./root.js";

export { root };
export * from "./client.js";
export * from "./queries.js";
export * from "./api-map.js";
export * from "./cloud.js";
export * from "./realtime.js";
export { syncIdentities, migrateIdentityConfigReferences } from "./commands.js";

export function createToniesSDK() {
  return createSDK(root);
}
