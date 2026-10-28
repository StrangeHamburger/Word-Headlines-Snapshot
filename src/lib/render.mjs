/**
 * 渲染（§11）。单文件 HTML，样式内联，不依赖任何外部资源——
 * 大陆网络环境下，少一个外链就少一次整页白屏的可能。
 *
 * 三条硬规则：
 *   1. 链接只在 linkDecoded=true 时渲染成 <a>（D25）。解不出来就纯文本，绝不让用户点进 Google 中转页。
 *   2. 共识条不带宽链接（D18）。
 *   3. 文案禁用「沉默/封锁/审查」这类指控性词（D27）。
 */

import { DISPLAY_ITEMS, CONSECUTIVE_TAG } from './constants.mjs';

const BANNED_WORDS = ['沉默', '封锁', '审查'];

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/** ISO 3166-1 alpha-2 → 国旗 emoji，省掉一套图片资源。 */
export function flagEmoji(code) {
  const upper = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '🏳️';
  return String.fromCodePoint(...[...upper].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

/** 时间统一按北京时间展示。 */
export function formatSlot(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
}

function pickDisplayItems(country) {
  const items = country.items || [];
  const wanted = country.displayItems || [];
  if (wanted.length === 0) return items.slice(0, DISPLAY_ITEMS);

  const byEvent = new Map(items.map((item) => [item.eventId, item]));
  const picked = wanted.map((eventId) => byEvent.get(eventId)).filter(Boolean);
  return picked.length > 0 ? picked.slice(0, DISPLAY_ITEMS) : items.slice(0, DISPLAY_ITEMS);
}

function renderItem(item) {
  const title = item.titleDisplay || item.titleOriginal || '';
  const linkable = item.linkDecoded === true && /^https?:\/\//.test(item.url || '');

  const badges = [];
  if (item.consensusCount >= 2) {
    badges.push(`<span class="badge badge--consensus">${item.consensusCount} 国共同报道</span>`);
  }
  if (item.consecutiveDays >= CONSECUTIVE_TAG) {
    badges.push(`<span class="badge badge--days">连续 ${item.consecutiveDays} 天</span>`);
  }

  const headline = linkable
    ? `<a class="item__title" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
    : `<span class="item__title">${escapeHtml(title)}</span>`;

  // 原文与译文不同时，把原文挂在下面——翻译有偏差时用户能自己核对
  const original =
    item.titleDisplay && item.titleDisplay !== item.titleOriginal
      ? `<p class="item__original" lang="${escapeHtml(item.lang || '')}">${escapeHtml(item.titleOriginal)}</p>`
      : '';

  return `<li class="item">
        ${headline}
        ${original}
        <p class="item__meta">${escapeHtml(item.publisher || '')}${badges.length ? ` ${badges.join(' ')}` : ''}</p>
      </li>`;
}

function renderCountry(country) {
  const items = pickDisplayItems(country);
  const silent = country.silentEvent;

  const silentBlock = silent
    ? `<p class="card__silent"><span class="card__silent-label">本期未包含</span>
          ${escapeHtml(silent.labelZh || silent.label || '')}
          <span class="card__silent-count">${silent.reportingCountries} 国在报</span></p>`
    : '';

  const offsetBlock =
    country.agendaOffset && country.agendaOffset.band && country.agendaOffset.band !== 'none'
      ? `<p class="card__offset"><span class="card__offset-label">议程偏移</span>
          ${escapeHtml(country.agendaOffset.note || '')}</p>`
      : '';

  const failed = country.status && country.status.ok === false;

  return `<article class="card${failed ? ' card--failed' : ''}">
      <header class="card__head">
        <span class="card__flag" aria-hidden="true">${flagEmoji(country.code)}</span>
        <h2 class="card__name">${escapeHtml(country.name)}</h2>
        <span class="card__code">${escapeHtml(country.code)}</span>
      </header>
      ${failed ? '<p class="card__empty">本期未取到数据</p>' : `<ul class="card__items">${items.map(renderItem).join('')}</ul>`}
      ${silentBlock}
      ${offsetBlock}
    </article>`;
}

/**
 * @param {object} snapshot 遵循 §5.3 契约
 * @returns {string} 完整 HTML
 */
export function renderHtml(snapshot) {
  const stats = snapshot.stats || {};
  const countries = snapshot.countries || [];
  const consensus = snapshot.topConsensus;

  const consensusBlock = consensus
    ? `<section class="consensus">
        <p class="consensus__label">${consensus.reportingCountries} 国同时报道</p>
        <h2 class="consensus__title">${escapeHtml(consensus.labelZh || consensus.label || '')}</h2>
      </section>`
    : '';

  const validCount = stats.countriesValid ?? countries.filter((c) => c.status?.ok).length;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>今天 ${countries.length} 国都在报什么</title>
<meta name="description" content="同一时刻，${countries.length} 个国家的头条放在一起：哪些事件大家都在报，哪些只有个别国家关注。">
<style>
  :root {
    --bg: #f7f7f5;
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --line: #e2e2de;
    --card: #ffffff;
    --accent: #b3462f;
    --consensus-bg: #fdf3ef;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f;
      --fg: #ecece8;
      --muted: #9a9a93;
      --line: #2e2e28;
      --card: #1c1c17;
      --accent: #e0765c;
      --consensus-bg: #2a1d18;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 20px 64px; }
  .masthead { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }
  .masthead h1 { font-size: 1.9rem; margin: 0 0 6px; letter-spacing: -0.01em; }
  .masthead p { margin: 0; color: var(--muted); font-size: 0.9rem; }
  .consensus {
    background: var(--consensus-bg);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 32px;
  }
  .consensus__label { margin: 0 0 4px; font-size: 0.8rem; letter-spacing: 0.08em; color: var(--accent); }
  .consensus__title { margin: 0; font-size: 1.15rem; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; }
  .card--failed { opacity: 0.55; }
  .card__head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .card__flag { font-size: 1.1rem; }
  .card__name { font-size: 1rem; margin: 0; font-weight: 600; }
  .card__code { margin-left: auto; font-size: 0.72rem; color: var(--muted); letter-spacing: 0.06em; }
  .card__items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .item__title { font-size: 0.95rem; font-weight: 500; text-decoration: none; color: var(--fg); }
  a.item__title:hover { color: var(--accent); text-decoration: underline; }
  .item__original { margin: 2px 0 0; font-size: 0.78rem; color: var(--muted); }
  .item__meta { margin: 4px 0 0; font-size: 0.75rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .badge { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 0.7rem; }
  .badge--consensus { color: var(--accent); border-color: currentColor; }
  .card__silent, .card__offset { margin: 14px 0 0; padding-top: 10px; border-top: 1px dashed var(--line); font-size: 0.8rem; color: var(--muted); }
  .card__silent-label, .card__offset-label { display: inline-block; margin-right: 6px; font-size: 0.7rem; letter-spacing: 0.06em; color: var(--accent); }
  .card__silent-count { white-space: nowrap; }
  .card__empty { color: var(--muted); font-size: 0.85rem; margin: 0; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 0.78rem; color: var(--muted); }
  footer p { margin: 0 0 6px; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <h1>今天 ${countries.length} 国都在报什么</h1>
    <p>${escapeHtml(formatSlot(snapshot.slot))} 更新 · ${validCount} 国有效样本 · 同一时刻的头条并排看</p>
  </header>
  ${consensusBlock}
  <main class="grid">
    ${countries.map(renderCountry).join('\n    ')}
  </main>
  <footer>
    <p>每条标题保留原文，译文仅供参考；标题链接指向发布方页面，解不出原始地址的条目不提供跳转。</p>
    <p>国家顺序固定，不按热度排序——排序本身会变成一种编辑立场。</p>
    <p>生成于 ${escapeHtml(snapshot.generatedAt || '')}</p>
  </footer>
</div>
</body>
</html>`;
}

/** 断言渲染结果里没有指控性词，CI 与测试共用。 */
export function findBannedWords(html) {
  return BANNED_WORDS.filter((word) => String(html).includes(word));
}