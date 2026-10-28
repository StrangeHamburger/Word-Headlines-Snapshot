/**
 * 向量化（§8.1）。三种 provider，接口一致，便于离线测试与降级。
 *
 *   e5     Xenova/multilingual-e5-small（q8，约 120 MB），真跨语言
 *   tfidf  语料内 TF-IDF，同语种有效，跨语种无效——降级用
 *   stub   确定性哈希词袋，只为在没有模型时跑通管线与测试
 *
 * 为什么把 provider 做成可注入：校准、单测、CI 自检都不该依赖 120 MB 模型下载。
 * 生产用 e5，其余两种只用于降级与测试。
 */

const DIM = 256;

function fnv1a(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

/** 拉丁按词切，CJK 按 2-gram 切（中文没有空格，整句会被当成一个 token）。 */
export function tokenize(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase();
  const tokens = [];

  const latin = normalized.match(/[a-z0-9]{2,}/g) || [];
  tokens.push(...latin);

  const cjkChars = [...normalized].filter((ch) => CJK.test(ch));
  for (let i = 0; i < cjkChars.length - 1; i += 1) {
    tokens.push(cjkChars[i] + cjkChars[i + 1]);
  }
  if (cjkChars.length === 1) tokens.push(cjkChars[0]);

  return tokens;
}

function l2normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/** 哈希词袋：同一个词进同一个桶，能近似反映共词程度。 */
function hashEmbed(text) {
  const vector = new Float32Array(DIM);
  for (const token of tokenize(text)) vector[fnv1a(token) % DIM] += 1;
  return l2normalize(vector);
}

/** 在给定语料上拟合 idf，然后逐条加权。 */
function createTfidf(texts) {
  const docs = texts.map((text) => tokenize(text));
  const df = new Map();
  for (const tokens of docs) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = docs.length || 1;
  const idf = (token) => Math.log((total + 1) / ((df.get(token) || 0) + 1)) + 1;

  return (text) => {
    const vector = new Float32Array(DIM);
    for (const token of tokenize(text)) vector[fnv1a(token) % DIM] += idf(token);
    return l2normalize(vector);
  };
}

async function createE5({ cacheDir = './.cache', batchSize = 16, quantized = true, remoteHost } = {}) {
  // 动态 import：没装依赖时不能让整个模块加载失败
  const { pipeline, env } = await import('@huggingface/transformers');
  // 缓存进仓库工作目录，CI 才能用 actions/cache 命中，不至于每次重下 120 MB
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;

  // 大陆网络下 huggingface.co 不通，但 hf-mirror.com 直连可用。
  // 用 HF_ENDPOINT 环境变量切换，不把镜像地址写死进代码。
  const host = remoteHost || process.env.HF_ENDPOINT;
  if (host) env.remoteHost = host;

  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    dtype: quantized ? 'q8' : 'fp32',
  });

  return async (texts) => {
    const output = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      // e5 训练时文档与前缀绑定；对称相似度两侧都用 query: 是模型卡推荐做法
      const result = await extractor(
        batch.map((text) => `query: ${text}`),
        { pooling: 'mean', normalize: true },
      );
      for (let i = 0; i < batch.length; i += 1) {
        output.push(Float32Array.from(result[i].data));
      }
    }
    return output;
  };
}

/**
 * 创建 embedder。
 *
 * @param {{provider?: 'e5'|'tfidf'|'stub', cacheDir?: string, corpus?: string[]}} options
 *        tfidf 需要 corpus（通常是本次全部标题）。
 * @returns {Promise<{name: string, dim: number, embed: (texts: string[]) => Promise<Float32Array[]>}>}
 */
export async function createEmbedder(options = {}) {
  const provider = options.provider || 'stub';

  if (provider === 'e5') {
    const embed = await createE5(options);
    return { name: `e5:${options.quantized === false ? 'fp32' : 'q8'}`, dim: 384, embed };
  }

  if (provider === 'tfidf') {
    const corpus = options.corpus || [];
    if (corpus.length === 0) throw new Error('tfidf provider 需要 corpus');
    const encode = createTfidf(corpus);
    return {
      name: 'tfidf',
      dim: DIM,
      embed: async (texts) => texts.map((text) => encode(text)),
    };
  }

  if (provider === 'stub') {
    return {
      name: 'stub',
      dim: DIM,
      embed: async (texts) => texts.map((text) => hashEmbed(text)),
    };
  }

  throw new Error(`未知的 embedding provider：${provider}`);
}

/** 余弦；输入应已 L2 归一化。 */
export function cosine(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}