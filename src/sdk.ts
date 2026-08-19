/**
 * The single access layer to the vendored DeepSeek Harness SDK client.
 *
 * The original `@deepseek-ai/dsh-desktop-pet` package depended on the
 * `@deepseek-ai/dsh-sdk-client` workspace package. This standalone project
 * vendors the built artifacts under `vendor/` (see `scripts/sync-vendor.mjs`)
 * and re-exports them here so no monorepo or workspace install is needed —
 * `npm install` only fetches `electron` from the registry. Everything else in
 * `src/` imports the SDK exclusively through this module.
 *
 * @module desktop-pet/sdk
 */

export {
  DeepSeekHarness,
  HarnessClient,
  HarnessSession,
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from '../vendor/dsh-sdk-client/index.js'

export type {
  ContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from '../vendor/dsh-sdk-client/types/types.js'
