/** Only these internal codes, phases and reason enums may cross into user-facing diagnostics. */
const SAFE_ERRORS: Record<string, string> = {
  SPEECH_UNSUPPORTED: '百炼短语音仅支持 Android 安装包，可使用文字输入',
  SPEECH_CONSENT_REQUIRED: '请点击开始或测试以继续',
  SPEECH_KEY_REQUIRED: '请先在设置中配置语音Key并通过连接测试',
  SPEECH_KEY_CHANGED: '语音 Key 已变化或清除，请重新核对设置后开始',
  SPEECH_KEY_STORAGE: '语音 Key 安全存储暂不可用，请在手机上重新保存',
  SPEECH_PERMISSION_DENIED: '麦克风未获授权，可在手机系统设置中允许后重试，或手动输入',
  SPEECH_PERMISSION_CANCELLED: '麦克风授权已取消，可重新开始或手动输入',
  SPEECH_BUSY: '已有语音或连接测试进行中，请先结束再重试',
  SPEECH_CONFIG_INVALID: '百炼语音配置无效，请核对高级设置与固定模型',
  SPEECH_AUTH: '百炼语音鉴权失败，请核对语音Key及高级设置中的地域',
  SPEECH_RATE_LIMIT: '百炼语音请求受限，请稍后重试',
  SPEECH_LIMIT: '本次录音已达30秒上限，已取消，请录更短的一句',
  SPEECH_TRANSCRIPT_LIMIT: '转录超过500字，未截断或入账，请录更短的一句',
  SPEECH_AUDIO_EMPTY: '未收到可核对的转写文字，请重试或手动输入',
  SPEECH_TIMEOUT: '语音等待超时，请检查网络后重新开始',
  SPEECH_TLS: '百炼安全连接失败，请检查手机系统时间与网络，不要绕过安全检查',
  SPEECH_NETWORK: '百炼语音网络连接中断，请检查网络后重试',
  SPEECH_AUDIO_UNAVAILABLE: '麦克风暂不可用，请关闭占用麦克风的应用后重试',
  SPEECH_AUDIO_ROUTE: '耳机音频未就绪或连接已变化，请确认耳机连接后重新开始',
  SPEECH_INTERRUPTED: '语音已被后台或来电中断，请重新开始',
  SPEECH_CANCELLED: '语音已取消，文字未发送给记账 AI',
  SPEECH_SESSION_INVALID: '本次语音会话已失效，请重新核对后开始',
  SPEECH_TRANSCRIPTION_FAILED: '百炼转写失败，请重试或使用文字输入',
  SPEECH_PROTOCOL: '会话配置核验未通过，已安全停止',
  SPEECH_PROVIDER: '百炼服务未接受请求，请核对模型权限及高级设置后重试',
};
const SAFE_PHASES: Record<string, string> = {
  validation: '检查设置', permission: '麦克风授权', connecting: '连接服务',
  configuring: '确认配置', microphone: '麦克风采集', transcribing: '语音转写',
};
// Keep aligned with GleamSpeechProtocolReason; never display field values or provider text.
const SAFE_REASONS: Record<string, string> = {
  ACK_SESSION_MISSING: '确认消息缺少会话配置',
  ACK_SESSION_NULL: '确认消息的会话配置为空',
  ACK_SESSION_TYPE: '会话配置的字段类型不符',
  ACK_MODEL_TYPE: '会话模型的字段类型不符',
  ACK_MODEL_MISMATCH: '会话模型与本次请求不一致',
  ACK_TURN_DETECTION_MISSING: '缺少轮次检测配置',
  ACK_TURN_DETECTION_TYPE: '轮次检测的字段类型不符',
  ACK_TURN_DETECTION_MISMATCH: '轮次检测未关闭',
  ACK_MODALITIES_MISSING: '缺少输出模式配置',
  ACK_MODALITIES_TYPE: '输出模式的字段类型不符',
  ACK_MODALITIES_MISMATCH: '输出模式未限定为仅文本',
  ACK_TRANSCRIPTION_MISSING: '缺少输入音频转写配置',
  ACK_TRANSCRIPTION_TYPE: '输入音频转写配置的类型不符',
  ACK_TRANSCRIPTION_MODEL_MISSING: '缺少输入音频转写模型',
  ACK_TRANSCRIPTION_MODEL_TYPE: '转写模型的字段类型不符',
  ACK_TRANSCRIPTION_MODEL_MISMATCH: '转写模型与本次请求不一致',
  ACK_AUDIO_MISSING: '缺少音频配置',
  ACK_AUDIO_TYPE: '音频配置的字段类型不符',
  ACK_AUDIO_INPUT_MISSING: '缺少音频输入配置',
  ACK_AUDIO_INPUT_TYPE: '音频输入配置的类型不符',
  ACK_AUDIO_FORMAT_MISSING: '缺少音频输入格式',
  ACK_AUDIO_FORMAT_TYPE: '音频输入格式的字段类型不符',
  ACK_AUDIO_ENCODING_MISSING: '缺少音频编码类型',
  ACK_AUDIO_ENCODING_TYPE: '音频编码类型的字段类型不符',
  ACK_AUDIO_ENCODING_MISMATCH: '音频编码与本次请求不一致',
  ACK_SAMPLE_RATE_MISSING: '缺少音频采样率',
  ACK_SAMPLE_RATE_TYPE: '音频采样率的字段类型不符',
  ACK_SAMPLE_RATE_MISMATCH: '音频采样率与本次请求不一致',
  ACK_SEARCH_TYPE: '搜索开关的字段类型不符',
  ACK_SEARCH_ENABLED: '搜索功能未关闭',
  ACK_TOOLS_TYPE: '工具配置的字段类型不符',
  ACK_TOOLS_NONEMPTY: '工具列表未清空',
  ACK_CHANNELS_TYPE: '音频声道数的字段类型不符',
  ACK_CHANNELS_MISMATCH: '音频声道数与本次请求不一致',
  ACK_SAMPLE_FORMAT_TYPE: '音频样本格式的字段类型不符',
  ACK_SAMPLE_FORMAT_MISMATCH: '音频样本格式与本次请求不一致',
  ACK_PACKING_TYPE: '音频排列方式的字段类型不符',
  ACK_PACKING_MISMATCH: '音频排列方式与本次请求不一致',
  ACK_CHANNEL_LAYOUT_TYPE: '声道布局的字段类型不符',
  ACK_CHANNEL_LAYOUT_MISMATCH: '声道布局与本次请求不一致',
  ACK_UNSAFE_CONFIGURATION: '会话配置未通过安全核验',
  FRAME_MALFORMED_JSON: '服务消息无法解析为规定格式',
  FRAME_OVERSIZED: '服务消息超过大小上限',
  FRAME_BINARY: '收到了不支持的二进制消息',
  FRAME_PROCESSING_FAILED: '服务消息处理未完成',
  COMMIT_ITEM_ID_INVALID: '音频提交标识无效',
  COMMIT_ITEM_ID_CONFLICT: '音频提交标识发生冲突',
  TRANSCRIPT_ITEM_ID_CONFLICT: '转写条目标识发生冲突',
  PROTOCOL_UNCLASSIFIED: '协议核验失败，未提供具体检查项',
  ACK_SERVER_SESSION_ID_TYPE: '服务端会话标识的字段类型不符',
  ACK_SERVER_SESSION_ID_INVALID: '服务端会话标识格式无效',
  ACK_SERVER_SESSION_ID_MISMATCH: '服务端会话标识前后不一致',
  ACK_UNEXPECTED_SESSION_EVENT: '会话事件顺序或确认状态不符',
  ACK_NESTED_TURN_DETECTION: '嵌套音频配置的轮次检测未关闭',
  UNEXPECTED_VAD_EVENT: '手动模式收到自动语音检测事件',
  UNEXPECTED_RESPONSE_EVENT: '收到未经请求的模型响应事件',
  BRIDGE_RESULT_TYPE: '原生桥返回结果的类型不符',
  BRIDGE_RESULT_SESSION_ID_MISSING: '原生桥结果缺少会话标识',
  BRIDGE_RESULT_SESSION_ID_TYPE: '原生桥会话标识的类型不符',
  BRIDGE_RESULT_SESSION_ID_MISMATCH: '原生桥结果不属于本次会话',
  BRIDGE_RESULT_CONNECTED_MISSING: '原生桥结果缺少连接确认',
  BRIDGE_RESULT_CONNECTED_TYPE: '原生桥连接确认的类型不符',
  BRIDGE_RESULT_CONNECTED_FALSE: '原生桥未确认连接成功',
};
const MAX_REASONS = 24;

export function shortVoiceError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { code?: unknown; data?: unknown } : {};
  const data = value.data && typeof value.data === 'object' ? value.data as { phase?: unknown; reason?: unknown; reasons?: unknown } : {};
  const code = typeof value.code === 'string' && Object.hasOwn(SAFE_ERRORS, value.code) ? value.code : undefined;
  const phase = typeof data.phase === 'string' && Object.hasOwn(SAFE_PHASES, data.phase) ? SAFE_PHASES[data.phase] : '未确定';
  const reasons: string[] = [];
  let truncated = false;
  // Bound both examined input and rendered output. Unknown strings never reach the DOM or clipboard.
  const candidates = [data.reason, ...(Array.isArray(data.reasons) ? data.reasons.slice(0, MAX_REASONS + 1) : [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !Object.hasOwn(SAFE_REASONS, candidate) || reasons.includes(candidate)) continue;
    if (reasons.length === MAX_REASONS) { truncated = true; break; }
    reasons.push(candidate);
  }
  const includeReasons = code === 'SPEECH_PROTOCOL' || data.reason !== undefined || data.reasons !== undefined;
  const detail = includeReasons ? `；原因：${reasons.length
    ? reasons.map(reason => `${SAFE_REASONS[reason]} [${reason}]`).join('；') + (truncated ? '；仅显示前24项' : '')
    : '未能确定具体检查项 [PROTOCOL_REASON_UNKNOWN]'}` : '';
  // Never stringify the error, its message, unknown metadata, or actual/expected provider values.
  return `${code ? SAFE_ERRORS[code] : '语音未完成，请检查权限、网络与语音配置，或改用手动输入'}（${code ?? 'SPEECH_UNKNOWN'}；阶段：${phase}${detail}）`;
}

