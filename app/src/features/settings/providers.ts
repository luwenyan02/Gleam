/** 保持设置模块的原导入路径兼容；目录在 core 层与请求校验共用。 */
export { AI_PROVIDERS, MODEL_CATALOG_CHECKED_ON, buildModelChoices, matchProviderId, modelPreset, recentModels } from '../../core/aiModels';
export type { AiProvider } from '../../core/aiModels';
