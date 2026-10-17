import { iconHtml } from '../../assets/icons';
import { MODEL_CATALOG_CHECKED_ON } from './providers';
import { openSheet, closeSheet } from '../shell/sheet';

type ManualFigure = { file: string; title: string; caption: string; marks: Array<[number, number, number]> };
const figures: ManualFigure[] = [
  { file: 'voice-start', title: '开始说话', caption: '① 点「开始说话」。也可直接输入文字。', marks: [[1, 9, 79.2]] },
  { file: 'voice-listening', title: '结束录音', caption: '② 出现「正在听」后说话，点「说完了」结束。', marks: [[2, 9, 94.8]] },
  { file: 'voice-review', title: '核对并发送', caption: '③ 核对或修改文字。④ 点「发送并生成草稿」，再核对草稿。', marks: [[3, 64, 79.2], [4, 37, 94.8]] },
  { file: 'voice-settings', title: '设置与连接测试', caption: '⑤ 选择 Key 来源并填好配置，点「测试语音连接」。通过后才保存；测试中可点同一按钮取消，录音仍需实际测试。', marks: [[5, 60, 56.6]] },
  { file: 'manual-entry', title: '找到使用手册', caption: '⑥ 我的 → 应用设置 → 关于拾光 → 使用手册。', marks: [[6, 66, 87.7]] },
];
function illustratedStepsHtml(): string {
  return `<section><h4>操作图解</h4><p>示例截图使用虚构数据。点图放大，再点缩小；放大后可上下、左右滚动。</p><div class="manual-gallery">${figures.map(figure => `<figure class="manual-figure"><div class="manual-image-viewport"><button type="button" class="manual-image-button" data-manual-zoom="${figure.title}" aria-label="放大图解：${figure.title}" aria-expanded="false"><span class="manual-image-frame"><img src="/manual/${figure.file}.png" width="390" height="844" alt="${figure.title}的拾光界面，操作说明见下方" loading="lazy">${figure.marks.map(([number, left, top]) => `<span class="manual-callout" aria-hidden="true" style="left:${left}%;top:${top}%">${number}</span>`).join('')}</span></button></div><figcaption>${figure.caption}</figcaption></figure>`).join('')}</div></section>`;
}

/** Read-only local reference. Opening it never reads credentials or calls a service. */
export function settingsManualHtml(): string {
  return `<div class="sheet-head"><h3 class="sheet-title">拾光使用手册</h3><button class="icon-btn" data-manual-close aria-label="关闭使用手册">${iconHtml('ic-close')}</button></div>
    <div class="sheet-scroll settings-manual">
      ${illustratedStepsHtml()}
      <section><h4>短语音记账</h4>
        <p>Android 安装版中，点「开始说话」录入一笔支出或收入，最长30秒；点「说完了」结束。转写文字可修改，也可直接手填。转账、借贷、还款、退款与报销使用手动记账。</p>
        <p>开始后，麦克风声音发送给阿里云百炼，地域、业务空间与模型以设置为准，可能产生服务商费用。拾光不保存录音。</p>
        <p>转写或编辑仅自动准备本机预览。点「发送并生成草稿」才将文字、候选分类和账户名称及识别规则发送至设置中的文字 AI 接口，可能产生模型费用；不附带声音、旧账单、余额、照片或生活记录。</p>
        <p>语音结果始终先形成草稿，不受自动入账阈值影响。点「填入当前草稿」会替换当前草稿的类型、金额、分类、账户、时间和备注；标签和凭证保持原选择，确认保存才入账。点「加入收件箱待确认」只保存到本机待确认队列，可修改后再确认入账。取消或返回不会开始下一次录音。</p>
      </section>
      <section><h4>语音设置与连接测试</h4>
        <p>语音Key可勾选「与 API Key 相同」，也可单独填写，必须与所选地域和业务空间匹配。已有独立Key保持原来源，不会自动切换。填写、切换来源和修改配置不会调用服务；明确测试通过后，才一并保存 Key、来源和配置。测试失败或取消保留原有生效配置。</p>
        <p>点「测试语音连接」后，使用所选 Key 向配置的百炼地址发送鉴权与会话配置请求，可能产生费用；不申请麦克风、不录音、不发送音频、文字或账本数据。连接通过不代表录音和实际转写已测试。共享来源的 API Key 变化后需重新测试，未通过前不会继续使用旧的共享Key。</p>
        <p>语音Key只在 Android Keystore 加密保存，不写入安装包、普通备份或账本；网页版不接收或保存。已存Key显示前后各5个字符，中间打码，较短Key全部打码；打码内容不是可提交的Key。</p>
        <p>测试结果使用轻提示显示；失败提示保留安全错误码与阶段，可截图反馈。诊断不包含原始服务响应、Key、录音或账本内容。</p>
      </section>
      <section><h4>文字 AI 与模型</h4>
        <p>识别请求直连设置中的 API 地址。Android 的文字 Key 由系统 Keystore 加密保存；网页版仅保留在当前标签页会话，关闭后需重新输入。</p>
        <p>普通 AI 记账在置信度达到阈值且分类、账户齐全时可自动入账，否则进入收件箱待确认。短语音草稿始终人工确认。</p>
        <p>模型预设目录核对于 ${MODEL_CATALOG_CHECKED_ON}，近期候选按最近三个月筛选，最多10个；离线目录不会自动联网更新。「获取模型列表」会调用所配置接口，返回模型的日期和能力未经目录核验。自定义模型的图片能力以接口实际支持为准。</p>
      </section>
      <section><h4>记账周期与报销</h4>
        <p>每月起始日决定首页总览、月报表和月预算的范围，设置页显示当前周期；周和年仍采用自然周期。开启「报销到账记为收入」会记录一笔报销收入，关闭则冲抵原支出，与报销页开关同步。</p>
      </section>
      <section><h4>备份、回收站与提醒</h4>
        <p>账本默认保存在本机。云备份或 AI 功能启用后，必要数据会发送给所配置的外部服务。备份生成与恢复位于「我的 → 备份与恢复」。</p>
        <p>删除的账单先进入回收站，可在保留期限内恢复；到期自动清理。</p>
        <p>Android 系统通知需授权：周期账当日09:00、信用卡还款日10:00提醒。网页版只在首页显示应用内提醒，关闭页面后不会在系统通知栏准时推送。</p>
      </section>
      <section><h4>外观与应用锁</h4>
        <p>「跟随系统」随设备深浅色变化。启用应用锁后每次打开需要解锁，PIN 以加盐哈希保存在本机，不上传；忘记 PIN 将无法解锁。</p>
      </section>
    </div>`;
}

export function openSettingsManual(): void {
  openSheet({ ariaLabel: '拾光使用手册', render(el) {
    el.innerHTML = settingsManualHtml();
    el.querySelector('[data-manual-close]')?.addEventListener('click', closeSheet);
    el.querySelectorAll<HTMLButtonElement>('[data-manual-zoom]').forEach(button => {
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', `${expanded ? '缩小' : '放大'}图解：${button.dataset.manualZoom}`);
        button.closest('.manual-figure')?.classList.toggle('is-zoomed', expanded);
        const viewport = button.parentElement;
        const marker = button.querySelector<HTMLElement>('.manual-callout');
        if (viewport) {
          viewport.scrollTop = expanded && marker ? Math.max(0, marker.offsetTop - viewport.clientHeight / 2) : 0;
          viewport.scrollLeft = expanded && marker ? Math.max(0, marker.offsetLeft - viewport.clientWidth / 2) : 0;
        }
      });
    });
  } });
}
