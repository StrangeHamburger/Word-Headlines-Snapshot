/**
 * 翻译（§7.5）。三种 provider 同一接口，密钥缺失时自动降级到 stub。
 *
 * 铁律：**翻译失败绝不阻塞发布**。拿不到译文就回退原文（titleDisplay = titleOriginal），
 * 页面照样出。宁可显示外文标题，也不能因为翻译接口挂了就没有站点。
 *
 * 预算：DeepL 免费版 50 万字符/月，我们按 40 万设闸；超了直接跳过翻译而不是报错。
 */

export const MONTH_CHAR_LIMIT = 400000;

async function deeplTranslate(entries, { apiKey, endpoint, target }) {
  const texts = entries.map((entry) => entry.text);
  const response = await fetch(`${endpoint}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: texts, target_lang: target === 'zh-CN' ? 'ZH' : target }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
  const json = await response.json();
  return (json.translations || []).map((item) => item.text);
}

async function workersAiTranslate(entries, { accountId, apiKey, target }) {
  // m2m100 必须显式给源语言，所以这条路径只能一条一条来
  const out = [];
  for (const entry of entries) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/m2m100-1.2b`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: entry.text,
          source_lang: (entry.lang || 'en').slice(0, 2),
          target_lang: 'zh',
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Workers AI HTTP ${response.status}`);
    const json = await response.json();
    out.push(json.result?.translated_text ?? null);
  }
  return out;
}

/**
 * @param {{provider?: 'stub'|'fake'|'deepl'|'workers-ai', apiKey?: string,
 *          accountId?: string, endpoint?: string, charsUsed?: number}} options
 */
export function createTranslator(options = {}) {
  let provider = options.provider || 'stub';
  const charsUsed = options.charsUsed || 0;

  // 没密钥就降级，不要抛错——发布流程不能因为缺密钥中断
  if ((provider === 'deepl' && !options.apiKey) || (provider === 'workers-ai' && !(options.apiKey && options.accountId))) {
    provider = 'stub';
  }

  const name = provider;

  async function translate(entries, { target = 'zh-CN' } = {}) {
    const chars = entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0);

    if (charsUsed + chars > MONTH_CHAR_LIMIT) {
      return { texts: entries.map(() => null), provider: name, chars: 0, skipped: 'month_budget' };
    }

    if (provider === 'stub') {
      return { texts: entries.map(() => null), provider: name, chars: 0, skipped: 'no_provider' };
    }

    if (provider === 'fake') {
      return {
        texts: entries.map((entry) => `［中译］${entry.text}`),
        provider: name,
        chars,
      };
    }

    try {
      let texts;
      if (provider === 'deepl') {
        texts = await deeplTranslate(entries, {
          apiKey: options.apiKey,
          endpoint: options.endpoint || 'https://api-free.deepl.com',
          target,
        });
      } else {
        texts = await workersAiTranslate(entries, {
          accountId: options.accountId,
          apiKey: options.apiKey,
          target,
        });
      }
      // 条数对不上说明接口返回异常，整批作废比错配安全
      if (texts.length !== entries.length) {
        return { texts: entries.map(() => null), provider: name, chars: 0, error: 'count_mismatch' };
      }
      return { texts, provider: name, chars };
    } catch (error) {
      return { texts: entries.map(() => null), provider: name, chars: 0, error: String(error?.message || error) };
    }
  }

  return { name, translate };
}