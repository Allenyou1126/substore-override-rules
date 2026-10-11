/**
 * @substore/internal —— 内部共享包。
 *
 * 只放两个交付包共用的**类型与运行时契约说明**，不放业务逻辑：
 * 业务实现属于 packages/substore-clean 与 packages/substore-rules。
 *
 * 该包不构建、不发布（private），由 tsdown 通过 deps.alwaysBundle 内联进产物。
 */

export type {
  SubStoreProcessControl,
  SubStoreProxy,
  SubStoreRequestInfo,
  SubStoreRequestOptions,
  SubStoreResponsePatch,
  SubStoreRuntimeGlobals,
  SubStoreScriptArguments,
  SubStoreScriptContext,
  SubStoreTargetPlatform,
} from './substore';
