const paths = {
  settings: '<path d="M3 6h7m4 0h7M3 12h2m4 0h12M3 18h11m4 0h3"/><circle cx="12" cy="6" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z" fill="currentColor" stroke="none"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/>',
  chat: '<path d="M7 19 3 21V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7Z"/><path d="M7 8h10M7 12h6"/>',
  idea: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4m0 3v.1"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  down: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  history: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m4-11h4m-4 6h4"/>',
  compose: '<path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6M15 4l5 5M10 14l1-5 8-8 4 4-8 8-5 1Z" transform="translate(0 1) scale(.9)"/>',
  bookmark: '<path d="M6 20V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v15l-6-4-6 4Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  voice: '<path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"/>',
};

export function chatIcon(name: keyof typeof paths): string {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
