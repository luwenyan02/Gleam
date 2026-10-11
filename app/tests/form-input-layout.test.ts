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

describe('browser layout checks wait for the current rendered card', () => {
  const test = readFileSync('e2e/test_form_input_layout.py', 'utf8');
  function callback(name: string, document: unknown, getComputedStyle?: unknown) {
    const source = test.match(new RegExp(`^${name} = '''([\\s\\S]*?)'''`, 'm'))?.[1];
    expect(source, `${name} must be the actual browser callback`).toBeDefined();
    return new Function('document', 'getComputedStyle', `return (${source});`)(document, getComputedStyle);
  }

  it.each([
    { name: 'empty', previous: '虚构午餐商家', value: '' },
    { name: 'long', previous: '', value: '虚构长商家名称'.repeat(12) },
    { name: 'short', previous: '虚构长商家名称'.repeat(12), value: '虚构修改商家' },
  ])('waits past typing until the new $name render', ({ previous, value }) => {
    const input = { value, defaultValue: previous };
    const card = { isConnected: true, querySelector: () => input };
    const rendered = callback('MERCHANT_RENDERED', { querySelector: () => card });
    expect(rendered({ selector: '#fixture', value })).toBe(false);
    input.defaultValue = value;
    expect(rendered({ selector: '#fixture', value })).toBe(true);
    card.isConnected = false;
    expect(rendered({ selector: '#fixture', value })).toBe(false);
    expect(test).toContain("page.wait_for_function(MERCHANT_RENDERED, arg={'selector': CARD, 'value': value})");
  });

  it('collects geometry from the live DOM instead of a previously resolved locator handle', () => {
    const box = { toJSON: () => ({ width: 140, height: 44, left: 20, right: 160 }) };
    const control = { getBoundingClientRect: () => box };
    const card = { isConnected: true, getBoundingClientRect: () => box, querySelector: () => control };
    const geometry = callback('CARD_GEOMETRY', { querySelector: () => card },
      () => ({ borderTopWidth: '1px', borderTopLeftRadius: '10px', boxShadow: 'none' }));
    expect(geometry('#fixture').controls).toHaveLength(6);
    expect(geometry('#fixture').controls[0]).toMatchObject({ width: 140, height: 44, border: '1px' });
    card.isConnected = false;
    expect(() => geometry('#fixture')).toThrow('Card is not connected');
    expect(test).toContain('geometry = page.evaluate(CARD_GEOMETRY, CARD)');
    expect(test).not.toContain('page.locator(CARD).evaluate');
  });
});
