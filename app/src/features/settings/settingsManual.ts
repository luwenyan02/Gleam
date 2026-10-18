import { iconHtml } from '../../assets/icons';
import { MODEL_CATALOG_CHECKED_ON } from './providers';
import { openSheet, closeSheet } from '../shell/sheet';

const topics = [
  ['start', '开始使用'], ['entry', '记一笔'], ['accounts', '账户与对账'],
  ['details', '明细、退款与报销'], ['reports', '报表与预算'], ['organize', '分类、标签与周期账'],
  ['life', '拾光与对话'], ['backup', '备份与恢复'], ['ai', 'AI 与短语音'],
  ['settings', '外观、安全与提醒'], ['update', '版本与更新'],
] as const;

type ManualFigure = { file: string; title: string; caption: string };
function pictures(figures: ManualFigure[]): string {
  return `<details class="manual-pictures"><summary>查看操作截图（${figures.length} 张）</summary><div class="manual-gallery">${figures.map(figure => `<figure class="manual-figure"><div class="manual-image-viewport"><button type="button" class="manual-image-button" data-manual-zoom="${figure.title}" aria-label="放大图解：${figure.title}" aria-expanded="false"><span class="manual-image-frame"><img src="/manual/${figure.file}.png" width="390" height="844" alt="${figure.title}的拾光示例界面，操作说明见下方" loading="lazy"></span></button></div><figcaption>${figure.caption}</figcaption></figure>`).join('')}</div></details>`;
}
function section(id: typeof topics[number][0], content: string): string {
  const title = topics.find(topic => topic[0] === id)![1];
  return `<section id="manual-${id}" tabindex="-1" aria-labelledby="manual-heading-${id}"><h4 id="manual-heading-${id}">${title}</h4>${content}<button class="manual-top" type="button" data-manual-section="contents">返回目录 ↑</button></section>`;
}

/** Local, read-only help. No credentials, ledger access or service requests. */
export function settingsManualHtml(): string {
  return `<div class="sheet-head"><h3 class="sheet-title">拾光使用手册</h3><button class="icon-btn" data-manual-close aria-label="关闭使用手册">${iconHtml('ic-close')}</button></div>
    <div class="sheet-scroll settings-manual">
      <div id="manual-contents" tabindex="-1"><p>从「我的 → 关于和帮助 → 使用手册」打开。按下面的目录查操作；截图使用虚构数据，点图可放大。</p>
      <nav class="manual-contents" aria-label="手册目录">${topics.map(([id, title]) => `<button type="button" data-manual-section="${id}">${title}</button>`).join('')}</nav></div>
      ${section('start', `<p>底部依次是「账户、报表、记一笔／首页、拾光、我的」。在首页点中央「＋」记账；在其他页点中央入口回首页。</p><p>首次使用先添加资金账户、填写初始余额，再记收支。已有拾光备份，先到「我的 → 备份与恢复」恢复。</p>${pictures([{ file: 'manual-entry', title: '找到使用手册', caption: '「我的」底部的「关于和帮助」提供使用手册和关于拾光。设置中心用于修改配置。' }])}`)}
      ${section('entry', `<ol><li>点首页「＋」，选择支出、收入、转账或借贷。</li><li>选择分类，输入金额，核对日期和账户；点「保存」完成，点「再记」保存后继续下一笔。</li><li>标签、商家和凭证在下方「更多」中。需要报销的支出，点亮「报销」再保存。</li></ol><p>常用分类最多四行五列，最后一格「更多」打开全部分类。大类按钮可横向滑动并快速定位；全部分类暂时收起计算器，选择后或点「收起」恢复原草稿；支出也可点顶部收起图标。分类名称单行显示，长名以省略号截断，选中后在上方查看。账户选择上方显示近一年同记账类型常用的最多 12 个账户；其余按类型排列。点右上角搜索图标查找，也可直接添加账户。</p><p>当天时间显示「今天 HH:mm」；其他日期将日期与时间分两行显示，同一个时间框内点「改为今天」可切到当前时间。计算器按输入顺序连续计算，不采用先乘除后加减；键盘底行、0 左侧的「清空」只清除金额和算式，退格键逐位删除。备注有内容时，最右侧「×」可一键清空，点文字区域直接编辑。</p><p>转账选择转出、转入账户；借贷选择借入／借出／还款／收款，以及资金账户和应收应付账户。这两类不是普通收支。</p>${pictures([{ file: 'entry', title: '手动记账', caption: '先核对类型、金额、分类、账户和时间。下方「更多」用于补充信息。' }, { file: 'account-picker', title: '选择账户', caption: '常用账户在上，其他账户按类型排列。搜索图标与「添加账户」在标题右侧。' }])}`)}
      ${section('accounts', `<p>「账户」查看净资产、分组余额和账户明细；点账户可编辑、查看余额趋势或对账。信用卡欠款用负余额表示。</p><p>流水按有记录的月份展示，长月份每次追加 80 笔，点「查看更多流水」继续查看；月度汇总和逐笔余额始终按完整流水计算。</p><p>余额与实际不符时，先核对漏记、重复和转账，再用「对账」录入实际余额。对账会留下调整记录，请核对差额后确认。</p><p>隐藏账户与是否计入净资产是两个独立选项。信用卡账户还可设置账单日、还款日，并管理手工账单与还款分配。</p>`)}
      ${section('details', `<p>首页默认展示当前记账月及前两个月的记录；到最底部后再次上拉，每次加载更早一个月，也可点底部按钮。最近一笔账单完全滚出屏幕顶部后，才显示悬浮月份概览；往回滚到该笔时隐藏。概览随当前浏览月份切换，点击可查看该记账月的全部账单明细。首页快捷入口可打开明细、日历；右上角搜索支持查找、筛选和批量操作。点账单打开详情，可编辑、再记、删除或退款。列表中的「复制」与详情的「再记」会带入原账单金额、备注、日期和业务选择，确认保存后才新增账单；原账单保持不变。键盘「再记」则是保存当前草稿后，清空金额与备注继续记下一笔。</p><p>搜索汇总显示结余、支出和收入；有对应账单时增加支出退款、转账、收款，卡片可横向滑动并点击筛选。收款指借贷中的收款；转账和收款不计入普通收支，退款继续按净支出口径计算。</p><ul><li><b>退款：</b>从原支出详情点「退款」，填写金额、到账账户与时间，保留与原支出的关联；不要另记一笔普通收入。</li><li><b>报销：</b>「我的 → 报销管理」勾选待报销支出，点「报销到账」。每笔确认后一次结清，实收不足的差额继续计入支出。</li><li><b>统计口径：</b>「报销款计入收入统计」开启时计收入，关闭时冲抵支出；与设置中心的开关同步。</li><li><b>删除：</b>先移入回收站，保留期内可恢复。永久删除和批量修改前，先核对已选范围。</li></ul>`)}
      ${section('reports', `<p>「报表」选择周、月、年或自定义日期，再切换趋势、分类、账户、标签、收入或商家。点击排行项目可查看对应明细；「展开全部」显示完整排行。</p><p>退款会减少净支出；多标签账单可能进入多个标签排行。环形图和排行统一按正净支出合计计算占比；退款超过支出的项目单列退款净额，不计入占比。正净支出减退款净额等于净支出。标签按标签正净额看构成，多标签账单会重复计入，未打标签的不计入标签构成。</p><p>「我的 → 预算中心」设置总预算和分类预算，点分类子预算可查看该周期明细（含小分类及退款）；可切换历史月份、复制上期或设置年度预算。每月起始日影响首页、月报和月预算；周、年仍按自然周期。</p>${pictures([{ file: 'report', title: '报表与明细', caption: '上方选日期范围，中间切换统计维度，点排行进入对应明细。' }])}`)}
      ${section('organize', `<ul><li><b>分类管理：</b>支出支持大类与小类，收入为单级；名称旁显示全部未删除账单笔数（含退款），大类合计包含自身与小类。点击编辑，拖动排序。点「合并分类」，依次选择原分类和保留的目标分类；确认前核对完整路径及账单数量。合并会同步迁移回收站、模板、周期账等引用并移除原分类，金额和余额不变。小类只能合并到小类，大类合并会迁移其小类；同名小类不自动合并。合并前创建的快照可在备份页 7 天内整体撤销，会回滚快照之后的其他修改。</li><li><b>标签与商家：</b>为账单补充筛选维度，可查看排行和关联明细。</li><li><b>速记模板：</b>保存常用分类、金额等内容，使用时仍核对本次账户和日期。</li><li><b>周期账：</b>创建固定收支或转账规则，核对金额、账户、频率与下次日期；暂停不再需要的规则，避免重复记账。</li><li><b>应收应付：</b>按账户查看待收、待还与往来明细；还款或收款使用借贷操作。</li></ul>`)}
      ${section('life', `<p>「拾光」记录日记、照片与习惯打卡，按月份回看。账单详情中点「给这一笔留下点记忆」，新记录会带入日期、分类、金额、账户及已有商家和备注，可直接修改补充；保存后自动关联原账单，不会重复记账。重新打开会保留已写内容。</p><p>「和拾光聊聊」确认发送后，返回其他页面不会停止回复，再次进入可继续查看；需要中止时点「停止」。若关闭应用、刷新或网络中断，会保留已保存的回复片段，点「重试」重新发送本轮，不会自动重发。</p><p>「拾光周刊」整理某周生活记录；AI 对话和生成需先配置接口，核对发送范围后再确认。AI 文字不是记账凭证，账单仍以已保存流水为准。</p>`)}
      ${section('backup', `<ol><li>进入「我的 → 备份与恢复」，点「立即备份」，可选口令加密，再生成并保存 .skbak 文件。</li><li>恢复时点「选择备份文件」，核对时点与数量后确认。恢复会全量替换当前数据；操作前自动创建的快照保留 7 天，可在本页撤销。</li><li>换手机或卸载前，把备份存到应用之外。加密口令无法找回；云端与 AI 凭证不随普通备份迁移，需要重新配置。</li></ol><p>备份摘要分别显示有效账单、回收站账单、账户和生活记录，完整备份包含回收站数据。本机副本及云端的详细说明点开后查看。本机保留最近 10 份备份副本，合计最多 100 MB；更早的备份需选择文件。Excel 用于按月查看与交换账单，不能完整恢复退款关联，完整迁移请用 .skbak。</p><p>挖财、微信和支付宝账单按导入页选择来源，先检查预览与账户映射，再确认导入。云备份支持 WebDAV、S3 兼容服务；Android 还支持邮件备份，测试连接和上传由你主动发起。</p>${pictures([{ file: 'backup', title: '备份与恢复', caption: '先把 .skbak 文件保存到应用之外。恢复前查看备份时间和记录数量。' }])}`)}
      ${section('ai', `<p><b>文字或截图：</b>在设置中心配置 AI 接口与模型，再从首页「AI 记账」输入或导入。设置中的「自动入账阈值」决定普通 AI 结果是否直接入账：达到阈值且分类、账户齐全时可直接入账；其他结果到「我的 → AI 记账收件箱」核对。</p><p><b>Android 短语音：</b>记账页点麦克风 →「开始说话」→「说完了」→ 核对文字 →「发送并生成草稿」。每次最长 30 秒，语音结果始终需要人工确认。转账、借贷、还款、退款与报销使用手动记账。</p><p>点「填入当前草稿」替换类型、金额、分类、账户、时间和备注，保留标签与凭证，保存后才入账。「加入收件箱待确认」只保存到本机待确认队列，可修改后再确认入账。</p>${pictures([
        { file: 'voice-start', title: '开始说话', caption: '主动点「开始说话」才录音，也可以直接输入文字。' },
        { file: 'voice-listening', title: '结束录音', caption: '看到「正在听」后说话，点「说完了」结束。' },
        { file: 'voice-review', title: '核对并发送', caption: '修改转写文字，再点「发送并生成草稿」。核对草稿后决定如何入账。' },
        { file: 'voice-settings', title: '语音连接设置', caption: '选择地域、业务空间和 Key 来源，点「测试语音连接」；通过后才保存。' },
      ])}<details class="manual-notes"><summary>连接、费用与隐私说明</summary><p>录音发送至所配置地域和业务空间的阿里云百炼，可能产生服务商费用；拾光不保存录音。点「发送并生成草稿」才把文字、候选分类与账户名称、识别规则发送给设置中的文字 AI 接口，不附带录音、旧账单、余额、照片或生活记录。</p><p>语音 Key 可与 API Key 相同，也可独立配置。填写配置不调用服务；连接测试只发送鉴权和会话配置，不申请麦克风、不录音、不发送音频、文字或账本数据，可能产生费用。测试中可点同一按钮取消，录音仍需实际测试。连接通过不代表录音和实际转写已测试；失败或取消保留原配置。共享 Key 更换后需重新测试。</p><p>Android Key 由 Keystore 加密保存；网页版文字 Key 只保留在当前标签页会话，网页版不保存语音 Key。打码内容不是可提交的 Key；测试报错可保留安全错误码反馈。</p><p>模型预设核对于 ${MODEL_CATALOG_CHECKED_ON}。「获取模型列表」会连接所填接口；返回的模型能力以服务实际支持为准。</p></details>`)}
      ${section('settings', `<p>「我的 → 设置中心」修改记账偏好、AI、通知、外观和应用锁，查看回收站保留期限。主题可选浅色、深色或跟随系统。</p><p>启用 PIN 后每次打开需解锁；PIN 以加盐哈希保存在本机，忘记 PIN 将无法解锁，请提前保留可用备份。回收站条目到期自动清除。</p><p>Android 授权系统通知后，周期账当日 09:00、信用卡还款日 10:00 提醒；网页版只显示首页提醒，关闭页面后不会在系统通知栏准时推送。</p>`)}
      ${section('update', `<p>「我的 → 关于和帮助 → 关于拾光」查看版本。Android 更新按钮依次为「检查更新 → 下载更新 → 更新」，下载时按钮底色显示进度。首次安装可能需要系统允许安装应用，授权后返回再点「更新」。</p><p>离开关于页后，已开始的下载可以继续。再次进入会先核验本地安装包：完整且校验通过时直接显示「更新」，未完成或已失效时回到「检查更新」。也可点「取消操作」停止下载。</p><p>私有仓库更新需在「GitHub 访问设置」点「粘贴」填入只读 Token，再点「保存并验证」。仅检查正式 Release；测试／预发布包不会出现在正式更新中。检查失败时核对网络、Token 有效期及仓库读取权限。</p><p>网页版不安装 APK，版本跟随当前网页部署。若预览仍显示旧界面，先确认预览服务已拉取对应分支，再刷新网页；不要为刷新版本清除账本数据。</p>`)}
    </div>`;
}

export function openSettingsManual(): void {
  openSheet({ ariaLabel: '拾光使用手册', render(el) {
    el.innerHTML = settingsManualHtml();
    el.querySelector('[data-manual-close]')?.addEventListener('click', closeSheet);
    el.querySelectorAll<HTMLButtonElement>('[data-manual-section]').forEach(button => {
      button.addEventListener('click', () => {
        const target = el.querySelector<HTMLElement>(`#manual-${button.dataset.manualSection}`);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-manual-zoom]').forEach(button => {
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', `${expanded ? '缩小' : '放大'}图解：${button.dataset.manualZoom}`);
        button.closest('.manual-figure')?.classList.toggle('is-zoomed', expanded);
        if (button.parentElement) {
          button.parentElement.scrollTop = 0;
          button.parentElement.scrollLeft = 0;
        }
      });
    });
  } });
}
