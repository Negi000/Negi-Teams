// Shared by the Vite workspace and authenticated server-rendered Task/review pages.
// Local assets only: opening an authenticated page never requests a font or icon CDN.
export const material3Styles = String.raw`
.negi-ui {
  --md-primary:#356845; --md-on-primary:#fff; --md-primary-container:#b9efc5;
  --md-on-primary-container:#143c23; --md-secondary:#526453; --md-secondary-container:#d6e9d4;
  --md-tertiary:#655783; --md-tertiary-container:#ebddff; --md-on-tertiary-container:#302246;
  --md-surface:#f7faf3; --md-surface-low:#f0f4eb; --md-surface-container:#e9eee4;
  --md-surface-high:#e1e7db; --md-surface-highest:#dbe2d5; --md-on-surface:#20271e;
  --md-on-surface-variant:#56614f; --md-outline:#788471; --md-outline-variant:#c6d0bf;
  --md-error:#a33232; --md-error-container:#ffdad6; --md-warning:#765800; --md-warning-container:#ffedb2;
  --md-inverse-surface:#2b3529; --md-inverse-on-surface:#eff5e9;
  --md-radius-sm:12px; --md-radius-md:20px; --md-radius-lg:28px; --md-radius-xl:36px;
  --md-motion:cubic-bezier(.2,.8,.2,1); --md-spring:cubic-bezier(.2,1.25,.35,1);
  --bg:var(--md-surface); --panel:var(--md-surface-low); --panel-2:var(--md-surface-container);
  --border:var(--md-outline-variant); --text:var(--md-on-surface); --muted:var(--md-on-surface-variant);
  --accent:var(--md-primary); --idle:var(--md-primary); --busy:var(--md-warning);
  margin:0; color:var(--md-on-surface); background:var(--md-surface);
  font:15px/1.6 "Segoe UI Variable", "Noto Sans JP", "Hiragino Sans", system-ui,sans-serif;
  -webkit-tap-highlight-color:transparent; color-scheme:light;
}
[data-theme=dark] .negi-ui {
  --md-primary:#9dd4a8; --md-on-primary:#073919; --md-primary-container:#245334;
  --md-on-primary-container:#b9efc5; --md-secondary:#baccaF; --md-secondary-container:#3b503e;
  --md-tertiary:#ccbbe9; --md-tertiary-container:#493b65; --md-on-tertiary-container:#ebddff;
  --md-surface:#111710; --md-surface-low:#1a2118; --md-surface-container:#20281e;
  --md-surface-high:#2a3327; --md-surface-highest:#343d30; --md-on-surface:#e2eadb;
  --md-on-surface-variant:#bdcbb6; --md-outline:#8e9c87; --md-outline-variant:#434f3d;
  --md-error:#ffb4ab; --md-error-container:#72312e; --md-warning:#e6c96b; --md-warning-container:#50420f;
  --md-inverse-surface:#dfe8d8; --md-inverse-on-surface:#23311f; color-scheme:dark;
}
.negi-ui *, .negi-ui *::before, .negi-ui *::after { box-sizing:border-box }
.negi-ui [hidden] { display:none!important }
.negi-ui a { color:var(--md-primary); text-underline-offset:3px }
.negi-ui button, .negi-ui input, .negi-ui select, .negi-ui textarea { font:inherit }
.negi-ui button, .negi-ui .md-button {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  min-height:48px; padding:12px 22px; border:0; border-radius:999px;
  background:var(--md-surface-high); color:var(--md-on-surface); font-size:14px; font-weight:650;
  cursor:pointer; text-decoration:none; transition:background 180ms var(--md-motion),border-radius 250ms var(--md-spring),transform 200ms var(--md-spring);
}
.negi-ui button:hover:not(:disabled), .negi-ui .md-button:hover { background:var(--md-secondary-container); filter:none }
.negi-ui button:active:not(:disabled), .negi-ui .md-button:active { border-radius:16px; transform:scale(.97) }
.negi-ui button:disabled { opacity:.5; cursor:default }
.negi-ui .md-primary, .negi-ui button.primary { background:var(--md-primary); color:var(--md-on-primary) }
.negi-ui .md-primary:hover:not(:disabled), .negi-ui button.primary:hover:not(:disabled) { background:var(--md-primary); box-shadow:0 2px 8px #0002 }
.negi-ui .md-tonal { background:var(--md-primary-container); color:var(--md-on-primary-container) }
.negi-ui .md-text { background:transparent; color:var(--md-primary) }
.negi-ui .md-danger { color:var(--md-error); background:var(--md-error-container) }
.negi-ui .md-icon-button { width:48px; padding:12px; flex:none }
.negi-ui :is(button,a,input,select,textarea,summary,[tabindex]):focus-visible {
  outline:3px solid var(--md-primary); outline-offset:4px;
}
.negi-ui input:not([type=checkbox]):not([type=radio]), .negi-ui select, .negi-ui textarea {
  min-height:52px; padding:13px 16px; background:var(--md-surface-container); color:var(--md-on-surface);
  border:1px solid var(--md-outline); border-radius:16px; width:100%; min-width:0;
  font-size:16px;
}
.negi-ui textarea { min-height:136px; resize:vertical }
.negi-ui label { display:block; font-size:14px; font-weight:550 }
.negi-ui label :is(input,select,textarea) { margin-top:6px }
.negi-ui input[type=checkbox] { width:20px; height:20px; accent-color:var(--md-primary) }
.negi-ui h1 { margin:0; font-size:clamp(26px,3vw,38px); letter-spacing:-.04em; line-height:1.25; font-weight:680 }
.negi-ui h2 { margin:0 0 12px; font-size:22px; letter-spacing:-.025em; line-height:1.4 }
.negi-ui h3 { margin:0 0 8px; font-size:16px }
.negi-ui p { margin:8px 0; overflow-wrap:anywhere }
.negi-ui .muted, .negi-ui small { color:var(--md-on-surface-variant); font-size:13px }
.negi-ui pre, .negi-ui code { font:13px/1.7 ui-monospace,"Cascadia Code",monospace; overflow-wrap:anywhere }
.negi-ui pre { margin:0; white-space:pre-wrap; min-width:0 }
.negi-ui summary { cursor:pointer; min-height:48px; padding:12px 4px; font-weight:650 }
.negi-ui .md-icon { width:24px; height:24px; flex:none; fill:currentColor }
.negi-ui .md-brand { display:flex; gap:12px; align-items:center; color:var(--md-on-surface); text-decoration:none }
.negi-ui .md-brand-mark {
  width:44px; height:44px; display:grid; place-items:center; background:var(--md-primary-container);
  color:var(--md-on-primary-container); border-radius:18px 18px 18px 6px; flex:none;
}
.negi-ui .md-brand-name { font-size:20px; font-weight:750; letter-spacing:-.05em; white-space:nowrap }
.negi-ui .md-brand-caption { display:block; font-size:11px; letter-spacing:.06em; color:var(--md-on-surface-variant) }
.negi-ui .md-topbar {
  display:flex; justify-content:space-between; align-items:center; gap:20px; min-height:88px;
  padding:16px 28px; padding-top:max(16px,env(safe-area-inset-top)); flex:none;
}
.negi-ui .md-topbar-actions { display:flex; align-items:center; gap:12px; min-width:0 }
.negi-ui .md-shell { display:grid; grid-template-columns:100px minmax(0,1fr); flex:1; min-height:0 }
.negi-ui .md-rail { display:flex; flex-direction:column; align-items:center; gap:8px; padding:8px 12px; }
.negi-ui .md-nav-item { display:flex; flex-direction:column; align-items:center; gap:4px; color:var(--md-on-surface-variant); text-decoration:none; width:76px; padding:4px 0; font-size:11px; font-weight:650; border-radius:20px }
.negi-ui .md-nav-indicator { display:grid; place-items:center; width:56px; height:36px; border-radius:20px; transition:background 220ms var(--md-motion),border-radius 220ms var(--md-spring) }
.negi-ui .md-nav-item:hover .md-nav-indicator { background:var(--md-surface-high) }
.negi-ui .md-nav-item[aria-current=page] { color:var(--md-on-primary-container) }
.negi-ui .md-nav-item[aria-current=page] .md-nav-indicator { background:var(--md-primary-container); border-radius:16px }
.negi-ui .md-nav-item[aria-disabled=true] { opacity:.45; pointer-events:none }
.negi-ui .md-page { min-width:0; padding:12px 32px 36px 16px; }
.negi-ui .md-page-heading { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:28px }
.negi-ui .md-page-heading p { color:var(--md-on-surface-variant); margin:8px 0 0; font-size:14px }
.negi-ui .md-eyebrow { font-size:12px; font-weight:650; color:var(--md-primary); margin-bottom:8px; letter-spacing:.06em }
.negi-ui .md-surface { background:var(--md-surface-low); padding:24px; border-radius:var(--md-radius-lg); min-width:0 }
.negi-ui .md-surface-tonal { background:var(--md-primary-container); color:var(--md-on-primary-container) }
.negi-ui .md-surface-tertiary { background:var(--md-tertiary-container); color:var(--md-on-tertiary-container) }
.negi-ui .md-section { margin-top:28px; min-width:0 }
.negi-ui .md-section-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:16px }
.negi-ui .md-section-heading h2 { margin:0 }
.negi-ui .md-section-heading a { font-size:13px; white-space:nowrap }
.negi-ui .md-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; overflow-wrap:anywhere; border-radius:8px; padding:4px 10px; font-size:12px; font-weight:650; line-height:1.5; background:var(--md-surface-high); color:var(--md-on-surface-variant) }
.negi-ui .md-chip-success { background:var(--md-primary-container); color:var(--md-on-primary-container) }
.negi-ui .md-chip-warning { background:var(--md-warning-container); color:var(--md-warning) }
.negi-ui .md-chip-error { background:var(--md-error-container); color:var(--md-error) }
.negi-ui .md-list { display:flex; flex-direction:column; gap:3px; min-width:0 }
.negi-ui .md-list-item {
  display:flex; align-items:center; gap:16px; padding:18px 20px; background:var(--md-surface-low);
  border-radius:4px; text-decoration:none; color:var(--md-on-surface); min-height:76px; min-width:0;
  transition:background 180ms var(--md-motion),border-radius 220ms var(--md-spring);
}
.negi-ui .md-list-item:first-child { border-radius:20px 20px 4px 4px }
.negi-ui .md-list-item:last-child { border-radius:4px 4px 20px 20px }
.negi-ui .md-list-item:only-child { border-radius:20px }
.negi-ui .md-list-item:hover { background:var(--md-surface-container) }
.negi-ui .md-list-item[aria-current=true] { background:var(--md-secondary-container); border-radius:20px }
.negi-ui .md-list-copy { min-width:0; flex:1; overflow-wrap:anywhere }
.negi-ui .md-list-copy strong { display:block; font-size:15px; font-weight:650 }
.negi-ui .md-list-copy small { display:block; margin-top:4px }
.negi-ui .md-list-symbol { width:44px; height:44px; flex:none; background:var(--md-surface-high); border-radius:16px; display:grid; place-items:center; color:var(--md-primary) }
.negi-ui .md-list-arrow { color:var(--md-on-surface-variant); flex:none }
.negi-ui .md-actions { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:20px }
.negi-ui .md-message { min-height:24px; color:var(--md-error); font-size:14px; overflow-wrap:anywhere }
.negi-ui .md-message:empty { min-height:0; margin:0 }
.negi-ui .md-message[data-tone=success] { color:var(--md-primary) }
.negi-ui .md-message[data-tone=neutral] { color:var(--md-on-surface-variant) }
.negi-ui .md-empty { padding:32px 24px; background:var(--md-surface-low); border-radius:28px; text-align:center; color:var(--md-on-surface-variant) }
.negi-ui .md-empty strong { display:block; font-size:18px; margin-bottom:8px; color:var(--md-on-surface) }
.negi-ui .md-list-detail { display:grid; grid-template-columns:280px minmax(0,1fr); gap:28px; align-items:start }
.negi-ui .md-list-pane { position:sticky; top:20px; min-width:0 }
.negi-ui .md-list-pane .md-list-item { align-items:flex-start; padding:16px; width:100%; text-align:left; justify-content:flex-start }
.negi-ui .md-list-pane .md-list-copy strong { font-size:14px }
.negi-ui .md-compact-picker { display:none }
.negi-ui .md-detail { min-width:0; animation:md-arrive 340ms var(--md-motion) }
.negi-ui .md-detail-header { margin-bottom:24px }
.negi-ui .md-detail-header h2 { font-size:26px; margin:14px 0 8px }
.negi-ui .md-detail-header #objective { font-size:15px; color:var(--md-on-surface-variant) }
.negi-ui .md-contract-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px }
.negi-ui .md-contract-grid li { margin:8px 0; overflow-wrap:anywhere }
.negi-ui li { overflow-wrap:anywhere }
.negi-ui .md-contract-grid ul { margin:0; padding-left:20px }
.negi-ui .md-key-values { display:grid; grid-template-columns:120px minmax(0,1fr); gap:8px 16px; margin:0 }
.negi-ui .md-key-values dt { color:var(--md-on-surface-variant); font-size:13px }
.negi-ui .md-key-values dd { margin:0; font-size:13px; overflow-wrap:anywhere }
.negi-ui .md-stepper { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; margin:24px 0 }
.negi-ui .md-step { padding:12px 8px; border-radius:14px; background:var(--md-surface-high); font-size:12px; text-align:center; color:var(--md-on-surface-variant) }
.negi-ui .md-step.current { background:var(--md-primary-container); color:var(--md-on-primary-container); font-weight:750 }
.negi-ui .md-step.done { background:var(--md-secondary-container); color:var(--md-on-surface) }
.negi-ui .md-step-number { display:block; font:700 20px/1.2 system-ui; margin-bottom:6px }
.negi-ui .md-supporting-layout { display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:24px; align-items:start }
.negi-ui .md-review-content { background:var(--md-surface-low); border-radius:28px; padding:28px }
.negi-ui .md-prose { font-size:15px; line-height:1.8; overflow-wrap:anywhere }
.negi-ui .md-prose h2 { font-size:22px; margin:28px 0 12px }
.negi-ui .md-prose h3 { margin:24px 0 12px }
.negi-ui .md-prose :is(ul,ol) { padding-left:24px }
.negi-ui .md-prose li { margin:10px 0 }
.negi-ui .md-prose code { background:var(--md-surface-container); border-radius:5px; padding:2px 4px }
.negi-ui .md-prose pre { background:var(--md-surface-container); padding:16px; border-radius:16px; margin:16px 0 }
.negi-ui .md-prose-table { overflow-x:auto }
.negi-ui .md-prose-table td, .negi-ui .md-prose-table th { padding:8px; border-bottom:1px solid var(--md-outline-variant) }
.negi-ui .md-review-inspector { position:sticky; top:20px; }
.negi-ui .md-review-jump { display:none }
.negi-ui #feedback-form, .negi-ui #acceptance-area { scroll-margin-top:20px }
.negi-ui .md-feedback { padding:16px 0; border-bottom:1px solid var(--md-outline-variant); overflow-wrap:anywhere; white-space:pre-wrap }
.negi-ui .md-feedback-options { margin-top:12px }
.negi-ui .md-feedback-options-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:8px 0 }
.negi-ui .md-review-inspector .md-actions button { width:100% }
.negi-ui .md-version { margin-top:24px; border-top:1px solid var(--md-outline-variant); padding-top:8px }
.negi-ui .md-dialog { border:0; border-radius:32px; background:var(--md-surface); color:var(--md-on-surface); padding:28px; max-width:560px; width:calc(100% - 32px); box-shadow:0 16px 64px #0003 }
.negi-ui .md-dialog::backdrop { background:#10241766; backdrop-filter:blur(3px) }
.negi-ui .md-dialog header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:20px }
.negi-ui .md-dialog label { margin-bottom:16px }
.negi-ui .md-switch-label { display:flex; align-items:center; gap:12px }
.negi-ui .md-switch-label { min-height:48px; cursor:pointer }
.negi-ui .md-theme-toggle { background:transparent }
.negi-ui .md-skip-link { position:fixed; left:16px; top:-100px; z-index:1000; padding:12px; background:var(--md-primary-container) }
.negi-ui .md-skip-link:focus { top:12px }
@keyframes md-arrive { from{opacity:.4;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
@media (max-width:1199px) {
  .negi-ui .md-list-detail { grid-template-columns:220px minmax(0,1fr); gap:20px }
  .negi-ui .md-supporting-layout { grid-template-columns:minmax(0,1fr) 290px; gap:16px }
  .negi-ui .md-page { padding-right:24px }
}
@media (max-width:959px) {
  .negi-ui .md-list-detail { grid-template-columns:minmax(0,1fr) }
  .negi-ui .md-list-pane { display:none }
  .negi-ui .md-compact-picker { display:flex; gap:12px; align-items:end; margin-bottom:20px }
  .negi-ui .md-compact-picker label { flex:1; min-width:0 }
  .negi-ui .md-supporting-layout { grid-template-columns:minmax(0,1fr) }
  .negi-ui .md-review-inspector { position:static }
  .negi-ui .md-review-jump { display:flex; margin-bottom:24px }
}
@media (max-width:599px) {
  .negi-ui .md-topbar { min-height:72px; padding:12px 16px; padding-top:max(12px,env(safe-area-inset-top)); gap:8px }
  .negi-ui .md-brand-caption { display:none }
  .negi-ui .md-brand-mark { width:38px; height:38px; border-radius:14px 14px 14px 5px }
  .negi-ui .md-brand-name { font-size:18px }
  .negi-ui .md-topbar-actions { gap:4px }
  .negi-ui .md-shell { display:block; padding-bottom:calc(90px + env(safe-area-inset-bottom)) }
  .negi-ui .md-rail { position:fixed; z-index:50; bottom:0; left:0; right:0; flex-direction:row; justify-content:space-evenly; gap:0; padding:10px max(4px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(4px,env(safe-area-inset-left)); background:var(--md-surface-container); border-radius:24px 24px 0 0; box-shadow:0 -4px 20px #00000008 }
  .negi-ui .md-nav-item { width:20%; font-size:10px; padding:0; border-radius:16px }
  .negi-ui .md-nav-indicator { width:48px; height:32px }
  .negi-ui .md-nav-item .md-icon { width:22px; height:22px }
  .negi-ui .md-page { padding:12px max(16px,env(safe-area-inset-right)) 24px max(16px,env(safe-area-inset-left)) }
  .negi-ui .md-page-heading { margin-bottom:24px; align-items:flex-start; gap:12px }
  .negi-ui .md-page-heading p { font-size:13px }
  .negi-ui .md-surface, .negi-ui .md-review-content { padding:20px; border-radius:24px }
  .negi-ui .md-detail-header h2 { font-size:22px }
  .negi-ui .md-list-item { padding:16px; gap:12px }
  .negi-ui .md-list-item .md-chip { max-width:96px; font-size:11px }
  .negi-ui .md-contract-grid, .negi-ui .md-feedback-options-grid { grid-template-columns:1fr }
  .negi-ui .md-key-values { grid-template-columns:1fr; gap:4px }
  .negi-ui .md-key-values dd { margin-bottom:12px }
  .negi-ui .md-actions { gap:10px }
  .negi-ui .md-actions>* { flex:1 1 auto }
  .negi-ui .md-step { font-size:11px; padding:10px 3px }
  .negi-ui .md-step-number { font-size:18px }
  .negi-ui .md-dialog { padding:22px; border-radius:28px }
}
@media (prefers-reduced-motion:reduce) {
  .negi-ui *, .negi-ui *::before, .negi-ui *::after { animation:none!important; transition:none!important; scroll-behavior:auto!important }
}
`;

const iconPaths: Record<string, string> = {
  leaf: '<path d="M20 3c-9-1-16 3-16 10a7 7 0 0 0 7 7c7 0 11-8 9-17ZM6 18l11-11M10 14v-4m0 4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  overview: '<path d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z"/>',
  task: '<path d="M5 3h14v18H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m8 9 2 2 5-5m-7 9h8m-8 3h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  review: '<path d="M4 4h16v12H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m8 10 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  workspace: '<path d="M3 4h18v16H3zM3 8h18m-14 4 3 2-3 2m6 0h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  usage: '<path d="M4 20V10h4v10m2 0V4h4v16m2 0V7h4v13"/>',
  theme: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  arrow: '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh: '<path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6M20 12a8 8 0 0 0-3-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  add: '<path d="M12 5v14m-7-7h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
export function materialIcon(name: string): string {
  return `<svg class="md-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] ?? iconPaths.task}</svg>`;
}
export function negiNavigation(active: string): string {
  return [
    ["overview", "/", "作業一覧"], ["task", "/tasks", "Task"], ["review", "/reviews", "レビュー"],
    ["workspace", "/?view=workspace", "チーム"], ["usage", "/?view=usage", "使用状況"],
  ].map(([id, href, label]) => `<a id="nav-${id}" class="md-nav-item" href="${href}"${active === id ? ' aria-current="page"' : ''}><span class="md-nav-indicator">${materialIcon(id)}</span><span>${label}</span></a>`).join("");
}
export function negiBrand(): string {
  return `<a class="md-brand" href="/"><span class="md-brand-mark">${materialIcon("leaf")}</span><span><span class="md-brand-name">Negi-Teams</span><span class="md-brand-caption">DEVELOPMENT WORKSPACE</span></span></a>`;
}
export const material3BootScript = String.raw`
(() => {
  const root=document.documentElement;
  try { root.dataset.theme=localStorage.getItem('negi-theme')==='dark'?'dark':'light'; } catch { root.dataset.theme='light'; }
  const update=()=>{const b=document.getElementById('theme-toggle');if(b){b.setAttribute('aria-label',root.dataset.theme==='dark'?'ライトテーマに切り替え':'ダークテーマに切り替え');b.setAttribute('aria-pressed',String(root.dataset.theme==='dark'));}};
  const init=()=>{update();document.getElementById('theme-toggle')?.addEventListener('click',()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('negi-theme',root.dataset.theme);}catch{}update();});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();`;

export function negiPageStart(title: string, active: string): string {
  // Both values are fixed caller literals, never request/query values.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} · Negi-Teams</title><link rel="icon" type="image/svg+xml" href="/negi-icon.svg"><style>${material3Styles}</style><script>${material3BootScript}</script></head><body class="negi-ui"><a class="md-skip-link" href="#main">本文へ</a><header class="md-topbar">${negiBrand()}<div class="md-topbar-actions"><button id="theme-toggle" class="md-icon-button md-theme-toggle" type="button" aria-label="テーマを切り替え">${materialIcon("theme")}</button></div></header><div class="md-shell"><nav class="md-rail" aria-label="メインナビゲーション">${negiNavigation(active)}</nav><main id="main" class="md-page">`;
}
