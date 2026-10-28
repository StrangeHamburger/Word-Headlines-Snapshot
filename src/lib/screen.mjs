/**
 * 内容筛查引擎。
 *
 * 设计约束（见 docs/02-detailed-design.md §7.6）：
 *   1. 在**指标计算之前**执行，剔除后从 rank limit+1 回补，保持样本条数不变。
 *   2. 工作在**事件簇**级别，不在单条级别。同一个事件在所有国家一起剔除，
 *      否则"本期前 N 条未包含"会变成对某国的错误指控。
 *   3. 默认规则集只输出 soft（待人工确认），不自动删任何东西。
 *      hard 规则由运营者自己加，且必须少而准。
 *
 * 规则文件里的具体词条属运营者所有：仓库只放通用模板，
 * 地域性规则写在 gitignore 的 sensitive.local.json 里。
 */

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const SEVERITY_RANK = { soft: 1, hard: 2 };

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 为一个 term 规则编译匹配器。
 * CJK 用子串匹配（中文没有词边界），拉丁文字用词边界，避免 "war" 命中 "software"。
 */
function compileTermMatcher(terms) {
  const cjkTerms = [];
  const latinTerms = [];

  for (const raw of terms) {
    const term = normalize(raw);
    if (!term) continue;
    if (CJK_RE.test(term)) cjkTerms.push(term);
    else latinTerms.push(term);
  }

  const latinRe = latinTerms.length
    ? new RegExp(`(?<![a-z0-9])(?:${latinTerms.map(escapeRegExp).join('|')})(?![a-z0-9])`, 'iu')
    : null;

  return (text) => {
    if (cjkTerms.some((term) => text.includes(term))) return true;
    return latinRe ? latinRe.test(text) : false;
  };
}

function compileRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (!rule.id || !rule.severity) return null;
  if (!SEVERITY_RANK[rule.severity]) return null;

  let matcher;
  if (rule.kind === 'regex') {
    if (!rule.pattern) return null;
    let re;
    try {
      re = new RegExp(rule.pattern, rule.flags || 'iu');
    } catch {
      return null; // 规则写错不应该让整条流水线崩
    }
    matcher = (text) => re.test(text);
  } else {
    if (!Array.isArray(rule.terms) || rule.terms.length === 0) return null;
    matcher = compileTermMatcher(rule.terms);
  }

  const langs = Array.isArray(rule.langs) && rule.langs.length > 0 ? rule.langs.map((v) => String(v).toLowerCase()) : ['*'];

  return {
    id: rule.id,
    severity: rule.severity,
    note: rule.note || '',
    appliesTo: (lang) => langs.includes('*') || langs.includes(String(lang || '').toLowerCase()),
    test: (text) => matcher(text),
  };
}

/**
 * 编译规则集。
 * @param {{rules?: any[], whitelist?: {terms?: string[]}}} ruleset
 */
export function createScreen(ruleset = {}) {
  const rules = (ruleset.rules || []).map(compileRule).filter(Boolean);

  const whitelistTerms = (ruleset.whitelist?.terms || []).map(normalize).filter(Boolean);
  const whitelistMatcher = whitelistTerms.length
    ? (text) => {
        const cjk = whitelistTerms.filter((term) => CJK_RE.test(term));
        const latin = whitelistTerms.filter((term) => !CJK_RE.test(term));
        if (cjk.some((term) => text.includes(term))) return true;
        if (latin.length) {
          const re = new RegExp(`(?<![a-z0-9])(?:${latin.map(escapeRegExp).join('|')})(?![a-z0-9])`, 'iu');
          return re.test(text);
        }
        return false;
      }
    : () => false;

  /**
   * 筛查一条文本。
   * @returns {{ hit: boolean, severity: 'hard'|'soft'|null, rules: {id:string,severity:string,note:string}[], whitelisted: boolean, normalized: string }}
   */
  function screen(text, lang = '') {
    const normalized = normalize(text);
    if (!normalized) {
      return { hit: false, severity: null, rules: [], whitelisted: false, normalized };
    }

    const hits = [];
    for (const rule of rules) {
      if (!rule.appliesTo(lang)) continue;
      if (rule.test(normalized)) hits.push({ id: rule.id, severity: rule.severity, note: rule.note });
    }

    if (hits.length === 0) {
      return { hit: false, severity: null, rules: [], whitelisted: false, normalized };
    }

    const whitelisted = whitelistMatcher(normalized);
    const hardHits = hits.filter((hit) => hit.severity === 'hard');

    // 白名单只能压住 soft；hard 永远优先
    if (whitelisted && hardHits.length === 0) {
      return { hit: false, severity: null, rules: hits, whitelisted: true, normalized };
    }

    const severity = hardHits.length > 0 ? 'hard' : 'soft';
    return { hit: true, severity, rules: hits, whitelisted: false, normalized };
  }

  /**
   * 簇级筛查：任一成员命中即整簇命中。
   * 这是唯一正确的调用方式——按条剔除会导致"未包含"错误指控。
   * @param {Array<{title:string, lang?:string}>} members
   */
  function screenCluster(members) {
    const hits = [];
    for (const member of members || []) {
      const verdict = screen(member.title, member.lang);
      if (verdict.hit) hits.push({ title: member.title, ...verdict });
    }
    if (hits.length === 0) {
      return { hit: false, severity: null, matched: [] };
    }
    const severity = hits.some((hit) => hit.severity === 'hard') ? 'hard' : 'soft';
    return { hit: true, severity, matched: hits };
  }

  return { screen, screenCluster, ruleCount: rules.length, forEachRule: (fn) => rules.forEach(fn) };
}

/** 校验规则文件结构，返回问题列表（空数组表示没问题）。 */
export function validateRuleset(ruleset) {
  const problems = [];
  if (!ruleset || typeof ruleset !== 'object') {
    return ['规则文件必须是 JSON 对象'];
  }
  if (ruleset.rules !== undefined && !Array.isArray(ruleset.rules)) {
    problems.push('`rules` 必须是数组');
  }
  const seen = new Set();
  (ruleset.rules || []).forEach((rule, index) => {
    const where = `rules[${index}]`;
    if (!rule || typeof rule !== 'object') {
      problems.push(`${where} 不是对象`);
      return;
    }
    if (!rule.id) problems.push(`${where} 缺少 id`);
    else if (seen.has(rule.id)) problems.push(`${where} id 重复：${rule.id}`);
    else seen.add(rule.id);

    if (!SEVERITY_RANK[rule.severity]) {
      problems.push(`${where}.severity 必须是 hard 或 soft，收到 ${JSON.stringify(rule.severity)}`);
    }
    if (rule.kind === 'regex') {
      if (!rule.pattern) problems.push(`${where} 是 regex 但缺少 pattern`);
      else {
        try {
          new RegExp(rule.pattern, rule.flags || 'iu');
        } catch (error) {
          problems.push(`${where}.pattern 无法编译：${error.message}`);
        }
      }
    } else if (!Array.isArray(rule.terms) || rule.terms.length === 0) {
      problems.push(`${where} 需要非空的 terms 数组`);
    }
  });
  return problems;
}