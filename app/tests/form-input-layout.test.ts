import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Structural CSS guards complement the browser geometry checks in test_form_input_layout.py. */
function declarations(path: string, selector: string): Record<string, string> {
  const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const result: Record<string, string> = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(',').map(value => value.trim()).includes(selector)) continue;
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}

describe('consistent merchant and related form inputs', () => {
  const inbox = 'src/features/ai-inbox/aiInbox.css';

  it('styles the editable merchant outside the two-column field grid', () => {
    expect(declarations(inbox, '.ai-merchant-field')).toMatchObject({
      display: 'flex', 'align-items': 'center', gap: '10px',
      'flex-basis': '100%', 'min-width': '0',
    });
    expect(declarations(inbox, '.ai-merchant-field input')).toMatchObject({
      border: '1px solid var(--border)',
      'border-radius': 'calc(var(--r) - 6px)',
      background: 'var(--surface)', color: 'var(--fg)',
      'font-family': 'var(--font-body)', 'min-height': '44px', 'min-width': '0',
    });
  });

  it('keeps amount, time, account, category and note controls equal-height and shrinkable', () => {
    expect(declarations(inbox, '.ai-fields')['grid-template-columns']).toBe('repeat(2,minmax(0,1fr))');
    expect(declarations(inbox, '.ai-fields label')['min-width']).toBe('0');
    for (const selector of ['.ai-fields input', '.ai-fields .ai-time-btn', '.ai-fields .ai-pick-btn']) {
      expect(declarations(inbox, selector)).toMatchObject({
        'min-height': '44px', 'min-width': '0', width: '100%',
        border: '1px solid var(--border)', 'font-family': 'var(--font-body)',
      });
    }
    expect(declarations(inbox, '.ai-fields .ai-pick-btn')).toMatchObject({
      display: 'block', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
    });
    expect(declarations(inbox, '.ai-actions')['flex-wrap']).toBe('wrap');
  });

  it('keeps merchant creation and shared picker search touch-sized without horizontal overflow', () => {
    expect(declarations('src/features/entry/entry.css', '.picker-new input')).toMatchObject({
      'min-height': '44px', 'min-width': '0',
    });
    expect(declarations('src/shared/pickList.css', '.picker-search input')['min-height']).toBe('44px');
  });

  it('aligns shared labeled inputs without extra bottom margins or intrinsic-width overflow', () => {
    expect(declarations('src/styles/base.css', '.field > .note')).toMatchObject({
      'min-width': '0', 'margin-bottom': '0',
    });
  });
});
