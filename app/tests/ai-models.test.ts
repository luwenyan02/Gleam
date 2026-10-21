import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, buildModelChoices, recentModels } from '../src/features/settings/providers';
import { assertImageModel, chatOptions } from '../src/core/aiChatOptions';

const today = new Date(2026, 8, 7);
describe('近期平台模型预设', () => {
  it('近期清单只包含最近三个日历月内的可追溯版本，每平台最多十个', () => {
    for (const provider of AI_PROVIDERS) {
      const models = recentModels(provider.id, today);
      expect(models.length).toBeGreaterThan(0);
      expect(models.length).toBeLessThanOrEqual(10);
      for (const model of models) {
        expect(model.availableOn >= '2026-06-07' && model.availableOn <= '2026-09-07').toBe(true);
      }
    }
    expect(recentModels('dashscope',today).map(m=>m.id)).toContain('qwen3.8-max-0902');
    expect(recentModels('dashscope',today).map(m=>m.id)).not.toContain('qwen3.7-plus');
    expect(recentModels('openai',new Date(2027,0,1))).toHaveLength(0);
  });
  it('百炼替换Flash并移除指定旧预设，仍保留用户已保存的模型', () => {
    const base='https://dashscope.aliyuncs.com/compatible-mode/v1';
    const checkedOn=new Date(2026,9,22);
    const options=buildModelChoices(base,'',null,checkedOn);
    expect(options[0]).toMatchObject({value:'deepseek-v4.1-flash-1017',note:'2026-10-17 · 图片／文本'});
    expect(options.map(m=>m.value)).toEqual(expect.arrayContaining(['qwen3.8-max-0902','qwen3.8-flash','kimi-k3']));
    for (const id of ['qwen3.7-plus','deepseek-v4-pro-0813','deepseek-v4-flash-0731']) {
      expect(AI_PROVIDERS.find(p=>p.id==='dashscope')!.models.some(m=>m.id===id)).toBe(false);
      expect(buildModelChoices(base,id,null,checkedOn)[0]).toMatchObject({value:id,group:'当前配置'});
    }
    expect(()=>assertImageModel(base,'deepseek-v4.1-flash-1017')).not.toThrow();
  });
  it('保留当前自定义值，忽略另一平台缓存，去重并限制十个', () => {
    const base='https://api.openai.com';
    const other=buildModelChoices(base,'my-model',{baseUrl:'https://api.deepseek.com',ids:['wrong-platform']},today);
    expect(other[0].value).toBe('my-model');
    expect(other.map(m=>m.value)).not.toContain('wrong-platform');
    const options=buildModelChoices(base,'my-model',{baseUrl:base,ids:Array.from({length:30},(_,i)=>`extra-${i}`)},today);
    expect(options).toHaveLength(10);
    expect(new Set(options.map(m=>m.value)).size).toBe(10);
  });
});

describe('新模型调用参数', () => {
  it('只调整已确认的不兼容参数，保留其他平台原有的低随机性', () => {
    expect(chatOptions('https://api.deepseek.com','deepseek-v4-pro')).toEqual({temperature:0});
    expect(chatOptions('https://open.bigmodel.cn/api/paas/v4','glm-5.2')).toEqual({temperature:0});
    expect(chatOptions('https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.8-flash')).toEqual({temperature:0,enable_thinking:false});
  });
  it('已知文本模型明确阻止截图识别，视觉或自定义模型不误拦截', () => {
    expect(()=>assertImageModel('https://api.deepseek.com','deepseek-v4-pro')).toThrow('仅支持文本');
    expect(()=>assertImageModel('https://api.deepseek.com','deepseek-v4-flash-vision-exp')).not.toThrow();
    expect(()=>assertImageModel('https://example.invalid','my-model')).not.toThrow();
  });
  it('GPT 和 Kimi 不发送不支持的固定 temperature，千问非流式显式关闭思考', () => {
    expect(chatOptions('https://api.openai.com','gpt-6-astra')).not.toHaveProperty('temperature');
    expect(chatOptions('https://api.moonshot.cn/v1','kimi-k3')).toEqual({reasoning_effort:'low'});
    expect(chatOptions('https://api.siliconflow.cn/v1','moonshotai/Kimi-K2.7-Code')).not.toHaveProperty('temperature');
    expect(chatOptions('https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.8-flash')).toMatchObject({enable_thinking:false});
    expect(chatOptions('https://example.invalid/v1','custom-model')).toEqual({temperature:0});
  });
});
