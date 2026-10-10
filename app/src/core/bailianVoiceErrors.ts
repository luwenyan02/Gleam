/** Only these internal codes and phases may cross into user-facing diagnostics. */
const SAFE_ERRORS: Record<string, string> = {
  SPEECH_UNSUPPORTED: '百炼短语音仅支持 Android 安装包，可使用文字输入',
  SPEECH_CONSENT_REQUIRED: '请先核对接收方与费用说明，再明确同意开始',
  SPEECH_KEY_REQUIRED: '请先在设置中保存独立百炼语音 Key',
  SPEECH_KEY_CHANGED: '语音 Key 已变化或清除，请重新核对设置后开始',
  SPEECH_KEY_STORAGE: '语音 Key 安全存储暂不可用，请在手机上重新保存',
  SPEECH_PERMISSION_DENIED: '麦克风未获授权，可在手机系统设置中允许后重试，或手动输入',
  SPEECH_PERMISSION_CANCELLED: '麦克风授权已取消，可重新开始或手动输入',
  SPEECH_BUSY: '已有语音或连接测试进行中，请先结束再重试',
  SPEECH_CONFIG_INVALID: '百炼语音配置无效，请核对地域、业务空间与固定模型',
  SPEECH_AUTH: '百炼语音鉴权失败，请核对独立 Key、地域与业务空间',
  SPEECH_RATE_LIMIT: '百炼语音请求受限，请稍后重试',
  SPEECH_LIMIT: '本次录音已达30秒上限，已取消，请录更短的一句',
  SPEECH_TRANSCRIPT_LIMIT: '转录超过500字，未截断或入账，请录更短的一句',
  SPEECH_AUDIO_EMPTY: '未收到可核对的转写文字，请重试或手动输入',
  SPEECH_TIMEOUT: '语音等待超时，请检查网络后重新开始',
  SPEECH_TLS: '百炼安全连接失败，请检查手机系统时间与网络，不要绕过安全检查',
  SPEECH_NETWORK: '百炼语音网络连接中断，请检查网络后重试',
  SPEECH_AUDIO_UNAVAILABLE: '麦克风暂不可用，请关闭占用麦克风的应用后重试',
  SPEECH_INTERRUPTED: '语音已被后台或来电中断，请重新开始',
  SPEECH_CANCELLED: '语音已取消，文字未发送给记账 AI',
  SPEECH_SESSION_INVALID: '本次语音会话已失效，请重新核对后开始',
  SPEECH_TRANSCRIPTION_FAILED: '百炼转写失败，请重试或使用文字输入',
  SPEECH_PROTOCOL: '百炼返回的会话配置或消息不符合要求，已安全停止，请核对模型后重试',
  SPEECH_PROVIDER: '百炼服务未接受请求，请核对模型可用性、地域与业务空间后重试',
};
const SAFE_PHASES: Record<string, string> = {
  validation: '检查设置', permission: '麦克风授权', connecting: '连接服务',
  configuring: '确认配置', microphone: '麦克风采集', transcribing: '语音转写',
};
export function shortVoiceError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; data?: unknown } : {};
  const data = value.data && typeof value.data === 'object' ? value.data as { phase?: unknown } : {};
  const code = typeof value.code === 'string' && Object.hasOwn(SAFE_ERRORS, value.code) ? value.code : undefined;
  const phase = typeof data.phase === 'string' && Object.hasOwn(SAFE_PHASES, data.phase) ? SAFE_PHASES[data.phase] : '未确定';
  // Never stringify the error, its message, an unknown code, or other provider fields.
  return `${code ? SAFE_ERRORS[code] : '语音未完成，请检查权限、网络、Key 与业务空间，或改用手动输入'}（${code ?? 'SPEECH_UNKNOWN'}；阶段：${phase}）`;
}
