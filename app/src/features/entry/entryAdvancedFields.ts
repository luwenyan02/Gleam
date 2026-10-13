import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { formatFen } from '../../core/money';
import type { QuickTemplate } from '../../core/types';

export function renderAdvancedFields(templates: readonly QuickTemplate[]): string {
  return `<section class="advanced-fields" id="advanced-fields" aria-label="更多记账信息" hidden>
    <div class="meta-row advanced-meta" aria-label="记账选项">
      <button class="chip" type="button" data-tpl-manage>${templates.length ? '管理模板' : '添加模板'}</button>
      <button class="chip" type="button" id="mark-tk" aria-pressed="false">退款</button>
      <button class="chip" type="button" id="chip-tag" aria-pressed="false">${iconHtml('ic-tag', 16)}<span id="tag-txt">标签</span></button>
      <button class="chip" type="button" id="chip-shop" aria-pressed="false">${iconHtml('ic-shop', 16)}<span id="shop-txt">商家</span></button>
      <button class="chip toggle-chip" id="life-toggle" type="button" role="switch" aria-label="同时写生活记录" aria-checked="false">生活记录</button>
    </div>
    <div class="tpl-row" id="tpl-row" aria-label="速记模板">
      <span class="tpl-lbl">速记</span>
      ${templates.map((template) => `<button class="chip" type="button" data-tpl="${template.id}">${esc(template.name)} ¥${formatFen(template.amount)}</button>`).join('')}
    </div>
    <div id="receipt-editor" aria-label="账单凭证"></div>
  </section>`;
}
