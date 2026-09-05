import { iconHtml } from '../../assets/icons';

/** 转账与借贷共用的类型表单骨架；状态与选择行为由协调器绑定。 */
export function renderTypeForms(): string {
  return `<div id="transfer-block" class="transfer" hidden>
    <button class="t-row" id="t-from"><span class="lbl">转出</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
    <span class="t-arrow">${iconHtml('ic-swap')}</span>
    <button class="t-row" id="t-to"><span class="lbl">转入</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
  </div>
  <div id="loan-block" hidden>
    <div class="transfer">
      <button class="t-row" id="loan-who"><span class="lbl">对象</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
      <button class="t-row" id="loan-acct"><span class="lbl" id="loan-acct-lbl">转入账户</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
    </div>
    <p class="tiny" id="loan-hint" style="padding:2px 4px 0"></p>
  </div>`;
}
