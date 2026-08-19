/**
 * TypeScript client SDK for the DeepSeek Harness runtime: spawn the
 * `dsh-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `DeepSeekHarness` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete harness configured by its own `cordis.yml`.
 *
 * @module @deepseek-ai/dsh-sdk-client
 */
export { DeepSeekHarness, HarnessSession } from './api.js';
export type { RunOptions } from './api.js';
export { HarnessClient, RequestTimeoutError, SdkProtocolError, TransportClosedError, } from './client.js';
export type { NotificationSubscription } from './client.js';
export { JsonRpcResponseError } from '../../dsh-sdk-protocol/index.js';
export type { ContentBlock, DeepSeekHarnessOptions, HarnessClientOptions, HarnessNotification, NotificationFilter, RunResult, } from './types.js';
//# sourceMappingURL=index.d.ts.map