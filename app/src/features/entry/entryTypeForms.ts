import { iconHtml } from '../../assets/icons';

/** 转账与借贷共用的类型表单骨架；状态与选择行为由协调器绑定。 */
export function renderTypeForms(): string {
  return `<div id="transfer-block" class="transfer" hidden>
    <button class="t-row" id="t-from"><span class="lbl">转出</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
    <button class="t-arrow t-swap" id="t-swap" type="button" aria-label="交换转出与转入账户" title="交换账户">${iconHtml('ic-swap')}</button>
    <button class="t-row" id="t-to"><span class="lbl">转入</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
  </div>
  <div id="loan-block" hidden>
    <div class="transfer" id="loan-flow">
      <button class="t-row" id="loan-who"><span class="lbl">对象</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
      <span class="t-arrow loan-arrow" id="loan-arrow" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><path d="M4 12h16m-6-6 6 6-6 6"/></svg></span>
      <button class="t-row" id="loan-acct"><span class="lbl" id="loan-acct-lbl">转入账户</span><b></b><span class="chev">${iconHtml('ic-right', 15)}</span></button>
    </div>
    <p class="tiny" id="loan-hint" style="padding:2px 4px 0"></p>
  </div>`;
}

/** 移动现有按钮而非只改 CSS order，使视觉方向与键盘焦点顺序一致。 */
export function orderLoanFlow(container: HTMLElement, outgoing: boolean): void {
  const account = container.querySelector('#loan-acct')!;
  const contact = container.querySelector('#loan-who')!;
  const arrow = container.querySelector('#loan-arrow')!;
  container.append(...(outgoing ? [account, arrow, contact] : [contact, arrow, account]));
}
