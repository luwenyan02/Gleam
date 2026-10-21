import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, buildModelChoices, recentModels, modelPreset } from '../src/features/settings/providers';
import { assertImageModel, chatOptions } from '../src/core/aiChatOptions';

const today = new Date(2026, 8, 7);
describe('近期平台模型预设', () => {
  it('近期清单只包含最近三个日历月内的可追溯版本，不把未知日期当作新发布', () => {
    for (const provider of AI_PROVIDERS) {
      const models = recentModels(provider.id, today);
      for (const model of models) {
        expect(model.availableOn && model.availableOn >= '2026-06-07' && model.availableOn <= '2026-09-07').toBe(true);
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
  it('保留当前自定义值，忽略另一平台缓存且完整保留候选', () => {
    const base='https://api.openai.com';
    const other=buildModelChoices(base,'my-model',{baseUrl:'https://api.deepseek.com',ids:['wrong-platform']},today);
    expect(other[0].value).toBe('my-model');
    expect(other.map(m=>m.value)).not.toContain('wrong-platform');
    const options=buildModelChoices(base,'my-model',{baseUrl:base,ids:Array.from({length:30},(_,i)=>`extra-${i}`)},today);
    expect(options.map(m=>m.value)).toEqual(expect.arrayContaining(Array.from({length:30},(_,i)=>`extra-${i}`)));
    expect(new Set(options.map(m=>m.value)).size).toBe(options.length);
  });
});

describe('新模型调用参数', () => {
  it('只调整已确认的不兼容参数，保留其他平台原有的低随机性', () => {
    expect(chatOptions('https://api.deepseek.com','deepseek-v4-pro')).toEqual({temperature:0,thinking:{type:'disabled'}});
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


describe('持续可用的模型目录与平台差异', () => {
  const checkedOn=new Date(2026,9,22);
  it('六个平台均有推荐，主推型号不会因超出三个月而消失', () => {
    for (const provider of AI_PROVIDERS) {
      expect(buildModelChoices(provider.baseUrl,'',null,checkedOn).some(m=>m.group==='推荐模型')).toBe(true);
      expect(buildModelChoices(provider.baseUrl,'',null,new Date(2027,0,22)).some(m=>m.group==='推荐模型')).toBe(true);
    }
    expect(buildModelChoices('https://api.moonshot.cn/v1','',null,checkedOn)).toEqual(expect.arrayContaining([
      expect.objectContaining({value:'kimi-k3',group:'推荐模型'})
    ]));
  });
  it('当前已知旧型号置顶去重，同时保留已核验能力', () => {
    const options=buildModelChoices('https://api.deepseek.com','deepseek-v4-flash',null,checkedOn);
    expect(options[0]).toMatchObject({value:'deepseek-v4-flash',group:'当前配置'});
    expect(options[0].note).toContain('图片／文本');
    expect(options.filter(m=>m.value==='deepseek-v4-flash')).toHaveLength(1);
    expect(()=>assertImageModel('https://api.deepseek.com','deepseek-v4-flash')).not.toThrow();
  });
  it('各平台调用名及图片能力独立，新推荐模型均有明确元数据', () => {
    for (const [provider,id] of [['openai','gpt-6.1-sol'],['openai','gpt-6-luna'],['deepseek','deepseek-flash'],['siliconflow','deepseek-ai/DeepSeek-V4.1-Flash'],['siliconflow','zai-org/GLM-5.3-Flash'],['siliconflow','Qwen/Qwen3.8-27B'],['zhipu','glm-5.3-flash'],['zhipu','glm-5.3-flashx']]) {
      const base=AI_PROVIDERS.find(p=>p.id===provider)!.baseUrl;
      expect(modelPreset(base,id)?.vision).toBe(true);
    }
    expect(modelPreset('https://api.deepseek.com','deepseek-v4.1-flash-1017')).toBeUndefined();
    expect(()=>assertImageModel('https://open.bigmodel.cn/api/paas/v4','glm-5.3')).toThrow('仅支持文本');
    const options=buildModelChoices('https://api.openai.com','',null,checkedOn);
    expect(options.find(m=>m.value==='gpt-6-sol')?.group).toBe('近期更新');
    expect(options.find(m=>m.value==='gpt-5.6-sol')?.group).toBe('兼容旧版');
  });
  it('只给对应服务商已核验型号发送兼容参数，不改变自定义代理', () => {
    for (const model of ['kimi-k2.7-code','kimi-k2.7-code-highspeed','kimi-k2.6']) {
      expect(chatOptions('https://api.moonshot.cn/v1',model)).not.toHaveProperty('temperature');
    }
    for (const model of ['glm-5.3','glm-5.3-flash','glm-5.3-flashx']) {
      expect(chatOptions('https://open.bigmodel.cn/api/paas/v4',model)).not.toHaveProperty('temperature');
      expect(chatOptions('https://open.bigmodel.cn/api/paas/v4',model)).not.toHaveProperty('thinking.type','disabled');
    }
    expect(chatOptions('https://api.deepseek.com','deepseek-flash')).toEqual({temperature:0,thinking:{type:'disabled'}});
    expect(chatOptions('https://api.openai.com','gpt-6.1-sol')).toEqual({reasoning_effort:'low'});
    expect(chatOptions('https://example.invalid/v1','glm-5.3-flash')).toEqual({temperature:0});
  });
});
