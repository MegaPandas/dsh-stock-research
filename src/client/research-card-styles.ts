// The host loads a single JS module for the plugin; keep scoped styles in that bundle.
export const researchCardStyles = `
.sr-research-card {
  --sr-ink: var(--dsw-alias-label-primary, #232733);
  --sr-muted: var(--dsw-alias-label-secondary, #626977);
  --sr-paper: var(--dsw-alias-bg-base, #ffffff);
  --sr-layer: var(--dsw-alias-bg-layer-1, #f7f8fa);
  --sr-line: var(--dsw-alias-border-l2, #e5e7ed);
  --sr-accent: var(--dsw-alias-label-deep-diving, #4d6bfe);
  --sr-success: light-dark(#197253, #80d6b0);
  --sr-warning: var(--dsw-alias-state-warn-primary, light-dark(#8c6018, #e6bd73));
  --sr-danger: var(--dsw-alias-state-error-primary, light-dark(#b43e47, #f1a0a6));
  --sr-tone: var(--sr-accent);
  --sr-tone-ink: color-mix(in srgb, var(--sr-tone) 84%, var(--sr-ink));
  container: sr-research / inline-size;
  position: relative;
  width: 100%;
  min-width: 0;
  margin-block: 16px;
  border: 1px solid var(--sr-line);
  border-radius: 16px;
  background: var(--sr-paper);
  box-shadow: 0 2px 6px #00000003, 0 8px 24px #00000003;
  color: var(--sr-ink);
  font: inherit;
  font-size: calc(14px + var(--dsh-content-font-delta, 0px));
  line-height: 1.6;
  overflow-wrap: anywhere;
  isolation: isolate;
}
.sr-research-card, .sr-research-card * { box-sizing: border-box; }
.sr-research-card svg { flex-shrink: 0; }
.sr-research-card[data-tone="success"] { --sr-tone: var(--sr-success); }
.sr-research-card[data-tone="warning"] { --sr-tone: var(--sr-warning); }
.sr-research-card[data-tone="danger"] { --sr-tone: var(--sr-danger); }
.sr-research-card[data-tone="neutral"] { --sr-tone: var(--sr-muted); }
.sr-research-card .sr-research-header::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 24px;
  width: 32px;
  height: 2px;
  border-radius: 2px;
  background: var(--sr-tone);
  transition: background-color 200ms ease;
}
.sr-research-card .sr-research-header { padding: 20px 24px; }
.sr-research-card .sr-research-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 18px;
}
.sr-research-card .sr-research-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--sr-muted);
  font-size: .857143em;
  font-weight: 500;
  letter-spacing: .07em;
}
.sr-research-card .sr-research-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 9px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--sr-tone) 7%, var(--sr-paper));
  color: var(--sr-tone-ink);
  font-size: .857143em;
  font-weight: 500;
  transition: color 200ms ease, background-color 200ms ease;
}
.sr-research-card .sr-research-signal {
  width: 5px;
  height: 5px;
  margin: 4px;
  border-radius: 50%;
  background: currentColor;
}
.sr-research-card[data-live="true"] .sr-research-signal {
  animation: sr-research-pulse 2.4s ease-in-out infinite;
}
.sr-research-card .sr-research-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 240px) minmax(0, 1fr);
  align-items: center;
  gap: 12px 24px;
}
.sr-research-card .sr-research-identity { min-width: 0; }
.sr-research-card .sr-research-chives {
  --sr-chive-leaf: light-dark(#4c8658, #80b78a);
  --sr-chive-dark: light-dark(#376f49, #639878);
  --sr-chive-light: light-dark(#85ad62, #b1ca8b);
  display: block;
  width: 100%;
  height: 92px;
  max-height: 92px;
  overflow: hidden;
  pointer-events: none;
}
.sr-research-card .sr-chives-soil { fill: color-mix(in srgb, var(--sr-chive-leaf) 7%, transparent); }
.sr-research-card .sr-chives-ground { stroke: color-mix(in srgb, var(--sr-chive-leaf) 25%, transparent); stroke-width: 1; }
.sr-research-card .sr-chives-cut-ends { stroke: light-dark(#b4c898, #c0d5aa); stroke-width: 1.5; }
.sr-research-card .sr-chives-plant,
.sr-research-card .sr-chives-clipping { fill: var(--sr-chive-leaf); }
.sr-research-card .sr-chives-shoot,
.sr-research-card .sr-chives-clipping { transform-origin: 0 0; }
.sr-research-card .sr-chives-leaf-light { fill: var(--sr-chive-light); }
.sr-research-card .sr-chives-leaf-dark { fill: var(--sr-chive-dark); }
.sr-research-card .sr-chives-clipping,
.sr-research-card .sr-chives-slash { opacity: 0; }
.sr-research-card .sr-chives-slash { stroke-dasharray: 1; stroke-linecap: round; }
.sr-research-card .sr-chives-slash-trail { stroke: var(--sr-chive-leaf); stroke-width: 1; opacity: .3; }
.sr-research-card .sr-chives-slash-edge { stroke: var(--sr-chive-light); stroke-width: 3; opacity: .65; }
.sr-research-card .sr-chives-slash-light { stroke: light-dark(#e2ecd4, #ebf5dd); stroke-width: 1.2; }
.sr-research-card [data-growing="true"] .sr-chives-shoot { animation: sr-chives-grow 12s ease-in-out infinite both; animation-delay: var(--sr-growth-delay); }
.sr-research-card [data-growing="true"] .sr-chives-clipping { animation: sr-chives-cut 12s ease-out infinite both; }
.sr-research-card [data-growing="true"] .sr-chives-slash { animation: sr-chives-harvest 12s linear infinite; }
.sr-research-card .sr-research-chives [data-extra="true"] { visibility: hidden; }
@container sr-research (min-width: 1040px) {
  .sr-research-card .sr-research-overview { grid-template-columns: minmax(0, 1fr) 430px minmax(0, 1fr); }
  .sr-research-card .sr-research-chives [data-extra="true"] { visibility: visible; }
  .sr-research-card .sr-chives-ground-compact { display: none; }
}
.sr-research-card .sr-research-title {
  margin: 0;
  color: var(--sr-ink);
  font: inherit;
  font-size: calc(19px + var(--dsh-content-font-delta, 0px));
  font-weight: 650;
  line-height: 1.45;
  letter-spacing: -.02em;
  text-wrap: pretty;
}
.sr-research-card .sr-research-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 8px;
  color: var(--sr-muted);
  font-size: .857143em;
  font-variant-numeric: tabular-nums;
}
.sr-research-card .sr-research-mode {
  padding-right: 12px;
  border-right: 1px solid var(--sr-line);
}
.sr-research-card .sr-research-elapsed {
  justify-self: end;
  align-self: end;
  color: var(--sr-muted);
  font-size: .857143em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sr-research-card .sr-research-body {
  margin: 0 24px;
  padding: 18px 0 20px;
  border-top: 1px solid var(--sr-line);
}
.sr-research-card .sr-research-progress-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.sr-research-card .sr-research-progress-label {
  flex: 1 1 12em;
  font-weight: 500;
  line-height: 1.65;
}
.sr-research-card .sr-research-count {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--sr-muted);
  font-size: .857143em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sr-research-card .sr-research-count strong {
  color: var(--sr-ink);
  font-size: calc(26px + var(--dsh-content-font-delta, 0px));
  font-weight: 550;
  line-height: 1;
  letter-spacing: -.04em;
}
.sr-research-card .sr-research-track {
  height: 4px;
  margin-top: 14px;
  overflow: hidden;
  border-radius: 4px;
  background: color-mix(in srgb, var(--sr-muted) 12%, var(--sr-paper));
}
.sr-research-card .sr-research-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--sr-tone);
  transform-origin: left;
  transition: transform 300ms cubic-bezier(.22, 1, .36, 1), background-color 200ms ease;
}
.sr-research-card .sr-research-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 12px;
  color: var(--sr-muted);
  font-size: .857143em;
}
.sr-research-card .sr-research-stats:empty { display: none; }
.sr-research-card .sr-research-stats > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sr-research-card .sr-research-stats svg { color: var(--sr-success); }
.sr-research-card .sr-research-missing svg { color: var(--sr-warning); }
.sr-research-card .sr-research-detail {
  margin: 12px 0 0;
  color: var(--sr-muted);
  white-space: pre-wrap;
}
.sr-research-card .sr-research-detail:first-child { margin-top: 0; }
.sr-research-card[data-tone="danger"] .sr-research-detail,
.sr-research-card[data-tone="warning"] .sr-research-detail {
  border-left: 2px solid var(--sr-tone);
  padding-left: 12px;
  color: var(--sr-ink);
}
.sr-research-card .sr-research-alert {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--sr-danger) 22%, var(--sr-paper));
  border-radius: 8px;
  background: color-mix(in srgb, var(--sr-danger) 5%, var(--sr-paper));
  color: var(--sr-ink);
  font-size: .928571em;
}
.sr-research-card .sr-research-alert:first-child { margin-top: 0; }
.sr-research-card .sr-research-result { margin-top: 14px; }
.sr-research-card .sr-research-result:first-child { margin-top: 0; }
.sr-research-card .sr-research-result-text {
  overflow: hidden;
  margin: 0;
  color: var(--sr-ink);
  font: inherit;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sr-research-card .sr-research-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  min-height: 60px;
  padding: 8px 16px;
  border-top: 1px solid var(--sr-line);
  border-radius: 0 0 16px 16px;
  background: color-mix(in srgb, var(--sr-layer) 55%, var(--sr-paper));
}
.sr-research-card .sr-research-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  max-width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sr-muted);
  font: inherit;
  font-size: .857143em;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
}
.sr-research-card .sr-research-action:focus-visible {
  outline: 2px solid var(--sr-accent);
  outline-offset: 2px;
}
.sr-research-card .sr-research-action:active:not(:disabled) {
  transform: translateY(1px);
  background: color-mix(in srgb, var(--sr-muted) 12%, transparent);
}
.sr-research-card .sr-research-action:disabled { cursor: default; opacity: .6; }
.sr-research-card .sr-research-cancel {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  z-index: 1;
}
.sr-research-card .sr-research-details {
  grid-column: 1 / -1;
  grid-row: 1;
  min-width: 0;
}
.sr-research-card .sr-research-details > summary {
  width: fit-content;
  max-width: calc(100% - 112px);
  list-style: none;
}
.sr-research-card .sr-research-details > summary::-webkit-details-marker { display: none; }
.sr-research-card .sr-research-details > summary svg,
.sr-research-card .sr-research-expand svg { transition: transform 180ms ease; }
.sr-research-card .sr-research-details[open] > summary svg { transform: rotate(90deg); }
.sr-research-card .sr-research-inspector {
  margin: 8px 8px 12px;
  padding-top: 20px;
  border-top: 1px solid var(--sr-line);
  animation: sr-detail-enter 180ms ease-out;
}
.sr-research-card .sr-detail-context { margin-bottom: 20px; }
.sr-research-card .sr-detail-context > span {
  color: var(--sr-muted);
  font-size: .857143em;
}
.sr-research-card .sr-detail-context > p { margin: 6px 0 0; font-size: .928571em; }
.sr-research-card .sr-detail-context:last-child { margin-bottom: 0; }
.sr-research-card .sr-detail-grid { display: grid; gap: 24px; }
.sr-research-card .sr-detail-grid[data-columns="two"] {
  grid-template-columns: minmax(200px, .8fr) minmax(0, 1.8fr);
}
.sr-research-card .sr-detail-grid > section { min-width: 0; }
.sr-research-card .sr-detail-section-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-height: 44px;
  margin-bottom: 16px;
}
.sr-research-card .sr-detail-section-heading h4 {
  margin: 0;
  font: inherit;
  font-size: .928571em;
  font-weight: 600;
  color: var(--sr-ink);
}
.sr-research-card .sr-detail-count {
  color: var(--sr-muted);
  font-size: .857143em;
  font-variant-numeric: tabular-nums;
}
.sr-research-card .sr-detail-task-list { list-style: none; margin: 0; padding: 0; }
.sr-research-card .sr-detail-task-list > li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--sr-line);
}
.sr-research-card .sr-task-mark {
  width: 7px;
  height: 7px;
  margin-top: 7px;
  flex-shrink: 0;
  border: 1.5px solid var(--sr-muted);
  border-radius: 50%;
}
.sr-research-card [data-status="running"] .sr-task-mark { border-color: var(--sr-accent); background: var(--sr-accent); }
.sr-research-card [data-status="completed"] .sr-task-mark { border-color: var(--sr-success); background: var(--sr-success); }
.sr-research-card [data-status="failed"] .sr-task-mark { border-color: var(--sr-danger); background: var(--sr-danger); }
.sr-research-card .sr-task-content { flex: 1; min-width: 0; }
.sr-research-card .sr-task-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.sr-research-card .sr-task-heading strong { font-size: .928571em; font-weight: 550; }
.sr-research-card .sr-task-heading > span { margin-left: auto; color: var(--sr-muted); font-size: .857143em; }
.sr-research-card .sr-task-content p { margin: 6px 0 0; color: var(--sr-muted); font-size: .857143em; line-height: 1.7; }
.sr-research-card .sr-log-view {
  display: inline-flex;
  max-width: 100%;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--sr-line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--sr-muted) 4%, var(--sr-paper));
}
.sr-research-card .sr-log-view .sr-research-action { padding-inline: 12px; }
.sr-research-card .sr-log-view [aria-pressed="true"] {
  color: var(--sr-ink);
  background: var(--sr-paper);
  box-shadow: 0 1px 3px #0000000a;
}
.sr-research-card .sr-log-stream + .sr-log-stream {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--sr-line);
}
.sr-research-card .sr-log-stream-name { margin: 0 0 12px; font-size: .928571em; font-weight: 550; }
.sr-research-card .sr-log-notice { margin: 0 0 12px; color: var(--sr-muted); font-size: .857143em; }
.sr-research-card .sr-log-collection {
  padding: 16px 20px;
  margin-bottom: 12px;
  border-radius: 10px;
  background: var(--sr-paper);
  border: 1px solid var(--sr-line);
}
.sr-research-card .sr-log-collection-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  color: var(--sr-muted);
  font-size: .857143em;
}
.sr-research-card .sr-log-collection-heading > span:first-child { color: var(--sr-ink); font-weight: 500; }
.sr-research-card .sr-log-metrics { display: flex; flex-wrap: wrap; gap: 16px 32px; margin: 16px 0 0; }
.sr-research-card .sr-log-metrics > div { flex: 1 1 64px; min-width: 0; }
.sr-research-card .sr-log-metrics dt { font-size: .857143em; color: var(--sr-muted); }
.sr-research-card .sr-log-metrics dd {
  margin: 4px 0 0;
  color: var(--sr-ink);
  font-size: 1.571429em;
  line-height: 1.3;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.03em;
}
.sr-research-card .sr-log-metrics small { color: var(--sr-muted); font-size: .6em; font-weight: 400; letter-spacing: 0; }
.sr-research-card .sr-log-entries { list-style: none; padding: 0; margin: 0; }
.sr-research-card .sr-log-entry {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 10px;
  padding: 14px 0;
}
.sr-research-card .sr-log-entry + .sr-log-entry { border-top: 1px solid var(--sr-line); }
.sr-research-card .sr-log-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  color: var(--sr-muted);
  font-size: 13px;
  font-weight: 600;
}
.sr-research-card [data-kind="diagnostic"] .sr-log-mark {
  color: var(--sr-warning);
  background: color-mix(in srgb, var(--sr-warning) 8%, var(--sr-paper));
}
.sr-research-card [data-kind="record"] .sr-log-mark { color: var(--sr-muted); background: var(--sr-paper); }
.sr-research-card .sr-log-entry-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.sr-research-card .sr-log-category { font-size: .857143em; color: var(--sr-muted); }
.sr-research-card .sr-log-source { font-size: .785714em; color: var(--sr-muted); padding-left: 10px; border-left: 1px solid var(--sr-line); }
.sr-research-card .sr-log-occurrences { margin-left: auto; font-size: .857143em; color: var(--sr-muted); font-variant-numeric: tabular-nums; }
.sr-research-card .sr-log-datasets { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 8px 0; }
.sr-research-card .sr-log-datasets code {
  min-width: 0;
  padding: 3px 8px;
  border: 1px solid var(--sr-line);
  border-radius: 5px;
  background: var(--sr-paper);
  color: var(--sr-ink);
  font: inherit;
  font-size: .857143em;
  overflow-wrap: anywhere;
}
.sr-research-card .sr-log-path {
  display: block;
  margin-top: 5px;
  font: inherit;
  font-size: .928571em;
  overflow-wrap: anywhere;
}
.sr-research-card .sr-log-path { color: var(--sr-muted); font-size: .857143em; }
.sr-research-card .sr-log-description { margin: 5px 0 0; color: var(--sr-muted); font-size: .857143em; line-height: 1.7; }
.sr-research-card .sr-log-message { margin: 0; font-size: .928571em; line-height: 1.7; white-space: pre-wrap; }
.sr-research-card .sr-log-earlier { width: 100%; margin-bottom: 4px; }
.sr-research-card .sr-log-raw {
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--sr-line) transparent;
  margin: 0;
  padding: 18px 20px;
  border: 1px solid var(--sr-line);
  border-radius: 10px;
  background: var(--sr-paper);
  color: var(--sr-muted);
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Consolas, system-ui, sans-serif;
  font-size: .857143em;
  line-height: 1.85;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sr-research-card .sr-log-raw:focus-visible { outline: 2px solid var(--sr-accent); outline-offset: 2px; }
@container sr-research (max-width: 720px) {
  .sr-research-card .sr-detail-grid[data-columns="two"] { grid-template-columns: minmax(0, 1fr); }
  .sr-research-card .sr-research-overview { grid-template-columns: minmax(0, 1fr) 120px; gap: 8px 16px; }
  .sr-research-card .sr-research-chives { grid-column: 2; grid-row: 1 / 3; align-self: center; height: 54px; }
  .sr-research-card .sr-research-elapsed { grid-column: 1; justify-self: start; white-space: normal; }
}
.sr-research-card .sr-research-expand {
  margin: 6px 0 -8px -8px;
  color: color-mix(in srgb, var(--sr-accent) 84%, var(--sr-ink));
}
.sr-research-card .sr-research-expand svg { transform: rotate(90deg); }
.sr-research-card .sr-research-expand[aria-expanded="true"] svg { transform: rotate(-90deg); }
@media (hover: hover) {
  .sr-research-card .sr-research-action:hover:not(:disabled) {
    color: var(--sr-ink);
    background: color-mix(in srgb, var(--sr-muted) 7%, transparent);
  }
  .sr-research-card .sr-research-cancel:hover:not(:disabled) { color: var(--sr-danger); }
}
@container sr-research (max-width: 420px) {
  .sr-research-card .sr-research-header::before { left: 16px; }
  .sr-research-card .sr-research-header { padding: 18px 16px; }
  .sr-research-card .sr-research-masthead { margin-bottom: 16px; }
  .sr-research-card .sr-research-meta { column-gap: 10px; }
  .sr-research-card .sr-research-mode { padding-right: 10px; }
  .sr-research-card .sr-research-overview { grid-template-columns: minmax(0, 1fr) 88px; gap: 8px 12px; }
  .sr-research-card .sr-research-chives { height: 40px; }
  .sr-research-card .sr-research-body { margin-inline: 16px; padding-block: 16px; }
  .sr-research-card .sr-research-footer { padding-inline: 8px; }
  .sr-research-card .sr-log-collection { padding: 14px; }
  .sr-research-card .sr-log-metrics { column-gap: 16px; }
  .sr-research-card .sr-log-view .sr-research-action { padding-inline: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .sr-research-card .sr-research-header::before,
  .sr-research-card .sr-research-status,
  .sr-research-card .sr-research-fill,
  .sr-research-card .sr-research-action,
  .sr-research-card .sr-research-action svg { transition: none; }
  .sr-research-card[data-live="true"] .sr-research-signal { animation: none; }
  .sr-research-card .sr-research-inspector { animation: none; }
  .sr-research-card [data-growing="true"] .sr-chives-shoot,
  .sr-research-card [data-growing="true"] .sr-chives-clipping,
  .sr-research-card [data-growing="true"] .sr-chives-slash { animation: none; }
}
@keyframes sr-chives-grow {
  0%, 72.1%, 100% { opacity: 0; transform: scale(.14, 0); }
  8% { opacity: 1; transform: scale(.18, .12); }
  28% { opacity: 1; transform: scale(.36, .4); }
  50% { opacity: 1; transform: scale(.64, .76); }
  66%, 72% { opacity: 1; transform: scale(1); }
}
@keyframes sr-chives-cut {
  0%, 72% { opacity: 0; transform: translate(var(--sr-cut-start), 83px) scale(var(--sr-plant-scale)); }
  72.1% { opacity: 1; transform: translate(var(--sr-cut-start), 83px) scale(var(--sr-plant-scale)); }
  80% { opacity: 1; transform: translate(var(--sr-bundle-x), 86px) rotate(var(--sr-bundle-angle)) scale(.32, .88); }
  82%, 94% { opacity: 1; transform: translate(var(--sr-bundle-x), 88px) rotate(var(--sr-bundle-angle)) scale(.32, .88); }
  100% { opacity: 0; transform: translate(var(--sr-bundle-x), 88px) rotate(var(--sr-bundle-angle)) scale(.32, .88); }
}
@keyframes sr-chives-harvest {
  0%, 70.5% { opacity: 0; stroke-dashoffset: 1; }
  70.6% { opacity: 1; stroke-dashoffset: 1; }
  78.5% { opacity: 1; stroke-dashoffset: 0; }
  81%, 100% { opacity: 0; stroke-dashoffset: 0; }
}
@keyframes sr-detail-enter {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes sr-research-pulse {
  0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 10%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 16%, transparent); }
}
`;
