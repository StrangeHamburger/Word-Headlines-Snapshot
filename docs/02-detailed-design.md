# 世界头条切片 — 详细设计

- 版本：v1.2-draft
- 日期：2026-10-28
- 基于：`id28_note.txt`（优化版方案）+ `docs/01-feasibility-review.md`
- 目标读者：实现者（单人全栈）、后续维护者
- 本文档是 V1 的实现依据；与可行性文档冲突时，以实现约束为准并更新两处
- v1.1 修订：见 §23。只处理**会导致实现出错或指标失效**的缺陷（阈值自相矛盾、示例时间戳指向未来、向量模型缓存路径错误、相似度公式退化、条目截断未定义、仓库体积失控、"前 15 条"硬门槛使功能永久不显示），不改动产品定位与架构。
- v1.2 决议：原 §21 的 7 个阻塞项与可行性文档 §8 的问题**已全部决议**，见 §2.1。实现不再等待外部答复；决议若变更，需同改 §2.1 与受影响章节。
- **v1.3 转向：受众改为中国大陆用户**（原 v1.2 的 D11「海外中文用户」被推翻）。这不是换一句文案，而是三条硬约束同时成立：①`*.pages.dev` 在大陆不稳定 → 必须绑自定义域名并提供大陆镜像路径；②Google 中转链接在大陆 100% 点不开 → 链接必须解码到发布方真实域名，失败则该条不可点；③多数外媒域名在大陆仍需境外网络 → **内容必须自包含**，跳转降级为附加动作。改动见 §2.1 的 D11/D12/D25–D27 与 §23.4。

> 命名提示：当前目录名为 `Word Headlines Snapshot`，产品名为「世界头条切片」，`Word` 疑为 `World` 笔误。建议在初始化仓库时改为 `world-headlines-snapshot`，目录名不影响本文档。

---

## 1. 目标与非目标

### 1.1 V1 目标

每 12 小时生成一份"15 国头条样本"快照，自动计算并标注四类信息：

1. **共识计数**：同一事件在多少个国家的样本中出现。
2. **本期未包含**：多国在报、但某国本期样本前 N 条中没有的事件（N 为该样本实际条数）。
3. **议程偏移**：某国主题分布与其余国家平均分布的差异档位。
4. **时间变化**：连续上榜天数、相对上次的突变。
5. **本期共识条**：全部国家里共识度最高的一个事件，置顶一行（D18）。
6. **中文译文**：展示用标题由机器翻译，可一键切回原文（D13）。

页面打开即见，零操作；不登录、不个性化、不做阅读器。

### 1.2 明确的非目标

- 不做全文/摘要/图片转载。
- 不做用户账户、收藏、评论、搜索、推送。
- 不做实时流；只有 12 小时快照。
- 不做管理后台；人工干预通过配置文件和覆盖表完成。
- 不宣称"客观""中立"；只声明样本口径。

### 1.3 关键口径（必须全站统一）

| 概念 | 口径 |
|---|---|
| "头版" | 不使用。统一称"Google News Top Stories 样本" |
| "未报道" | 不使用。统一称"本期前 N 条未包含"，N 取该国实际条数，不写死 15 |
| "15 条" | 是样本上限（`feeds.json` 的 `limit`），不是保证；实际条数以 `itemsValid` 为准并在界面体现 |
| "沉默" | 仅作为内部术语，界面不出现 |
| 共识分母 | 本次抓取成功的有效国家数（条目 ≥ 10），不是固定 15 |
| 突变 | 相对"上一次快照"，不承诺是"今天 vs 昨天" |
| 连续天数 | 按自然日去重，一天最多计 1 天 |
| **内容自包含**（v1.3） | 页面上的全部信息——译文标题、标记、来源名、域名、时间——不依赖任何境外网站可达。跳转原文是附加动作，不是产品可用性的前提 |
| **发布物链接**（v1.3） | 只允许发布方真实域名；禁止 Google 中转链接；不可还原的条目不渲染为链接 |
| **剔除**（v1.4） | 按**事件簇**整簇剔除，且在指标计算之前完成；剔除后从 rank `limit+1` 起回补，每国样本仍为 15 条。页面不展示剔除内容，但剔除数量在 `/status` 公开（§7.6） |

---

## 2. 关键设计决策（ADR）

| # | 决策 | 理由 | 替代方案与否决原因 |
|---|---|---|---|
| D1 | 前端预渲染静态 HTML，不在浏览器取 JSON | LCP 快、无 JS 也能看、无请求瀑布 | 客户端渲染：首屏慢，且无 JS 时空白 |
| D2 | 事件聚类用本地多语言向量 + 实体/数字加权 | 跨 10 种语言唯一的零成本确定性方案 | 纯关键词：跨语言不可行；LLM：非确定、外部依赖 |
| D3 | 主题分类用英文锚点原型的跨语言相似度 | 避免维护 10 种语言 × 11 主题的关键词表 | 多语言关键词表：维护成本高、覆盖差 |
| D4 | 阈值宁严勿宽，精确率优先于召回率 | 错标"未包含"会被截图放大 | 高召回：错误率高，产品可信度崩塌 |
| D5 | 只在源健康且条目充足时输出标记 | 抓取失败不等于沉默 | 无条件输出：把工程故障说成媒体行为 |
| D6 | 保留 7 天、每天 2 份快照，随仓库提交 | 无数据库、可回滚、可审计 | 外部 KV：增加依赖；单文件覆盖：丢历史 |
| D7 | GitHub Actions 抓取 + Cloudflare Pages 托管 | 零成本、运维面最小 | Worker Cron：更准时，但向量模型跑不动 |
| D8 | 标题机翻作为可关闭的展示选项 | 不翻则中文用户读不懂 10 国标题 | 强制原文：核心体验不成立 |
| D9 | 国旗用内联 SVG sprite，不用 emoji | Windows 不渲染国家旗帜 emoji | emoji：Windows 显示为字母对 |
| D10 | 所有外部文本一律转义，链接协议白名单 | 标题是外部不可信输入 | 直接插值：XSS |

### 2.1 决策补录（v1.2，全部已决议）

v1.0 的 §21 与可行性文档 §8 共列了 14 个待决项。以下逐条给出**决议、理由与被否决的选项**；实现按此执行，不再等待答复。

| ID | 问题 | 决议 | 理由 | 被否决的选项 |
|---|---|---|---|---|
| D11 | 首发受众 | **中国大陆用户**（v1.3 转向）。形态为**内容自包含的对比结果页**：译文标题、四个标记、来源名、时间全部在页面内可读；"跳原文"降级为附加动作 | 产品卖点是"对比结论"而非"读新闻"。结论在页面内即可交付，不依赖任何境外网站可达——这是面向大陆用户时唯一能成立的形态 | ①海外优先（v1.2 原决议，因受众判断变化被推翻）；②只做截图传播（放弃站点）；③只展示原文不翻译（大陆用户读不懂 11 国标题） |
| D12 | 大陆可达性 | **一套产物、双托管**：海外主站（Cloudflare Pages + **自定义域名**，不用 `pages.dev`）+ 大陆镜像（阿里云/腾讯云 OSS + CDN，**需备案域名**）。镜像为可选构建目标，`dist` 完全相同 | 大陆用户能否打开决定一切；`*.pages.dev` 在大陆解析与访问不稳定，必须绑自有域名。有备案则加镜像，无备案则只用海外站并如实告知 | ①只放海外站且不绑域名（打开率不可控）；②只放大陆云（无备案无法上线，且境外新闻聚合的备案与内容审核风险极高）；③用国内源替代 Google News（产品定义改变） |
| D13 | 标题机翻 | **做，默认展示中文译文**，每张卡片可切原文，选择记入 localStorage | 不做则 15 国里 11 国标题对中文用户不可读，"10 秒读懂"直接失效；卡片会退化成看不懂的色块 | ①完全不做；②只翻事件标签（正文仍不可读） |
| D14 | 翻译供应商 | **DeepL Free 为主 → Cloudflare Workers AI `@cf/meta/m2m100-1.2b` 兜底 → 都没有则降级为原文** | DeepL 对日/韩/德法等→中文的质量明显优于开源模型，Free 版 50 万字符/月足够（见 §7.5 配额测算）；m2m100 在同一平台上，兜底不引入第二个计费方 | ①Google 翻译非官方端点（无 SLA、随时失效）；②本地 OPUS-MT（每条语言对 80 MB × 10，体积和冷启动都不可接受）；③付费 DeepL Pro（V1 无收入） |
| D15 | 翻译范围 | **只翻展示用文本**：45 条展示标题 + ≤15 条未包含标签 + ≤1 条共识条标签，合计 ≤61 条/次；按标题哈希永久缓存 | 聚类用多语言向量，原文即可；把 225 条全翻是 3 倍成本、零收益 | 全量翻译（成本×3.7，且不改善任何指标） |
| D16 | 15 国还是 9 国语种圈 | **15 国**，并配 **5 国备用池**；某国连续 3 次样本不足则替换国家，不缩减国家数 | "世界各地"是唯一差异点；缩到 9 国后与 Crosswire 无区别。条目不足的正确应对是换源/换国，不是砍掉半个地球 | ①缩到 9 国（卖点消失）；②为凑数容忍 8 条样本的国家（指标全失真） |
| D17 | 展示 3 条还是 5 条 | **3 条** | 保持"切片感"与卡片等高；样本波动要用计算样本 N（15）解决，不是靠多摆两条标题 | 5 条（卡片高 1.7 倍，移动端一屏不到 1 张卡） |
| D18 | 首页是否增设"本期共识" | **增设顶部一条自动共识条**（取共识国家数最高的 1 个事件），纯文本不可点击 | 直接满足"10 秒内说出哪条是全球共识"的验收标准；且它是计算结果而非人工挑选，不破坏"搬运工"原则。不设链接，因为"选哪条原文"本身就是编辑判断 | ①不设（用户仍需自己扫 15×3 条）；②可点击（等价于替用户选了一个来源） |
| D19 | 本地多语言模型 | **接受**，q8 量化约 120 MB，走 §8.1 的缓存方案 | 零 API 费、同输入同输出、可复现；已有模型不可用时的降级路径 | ①纯关键词（跨语言不可行）；②Workers AI 做聚类（每次调用非确定，无法复现历史） |
| D20 | 仓库/域名/邮箱 | 仓库名 **`world-headlines-snapshot`**（修正 `Word` 笔误）；**开发期内测可用 `*.pages.dev`，对大陆公开发布前必须绑定自定义域名**（v1.3 收紧）；`feedback@` 上线前替换占位 | 大陆用户能稳定打开是对外发布的前提；`pages.dev` 只适合自测 | 一开始就买域名（可先开发）；公开发布仍用 `pages.dev`（大陆打开率不可控） |
| D21 | 未包含文案 | 界面固定：`本期前 {N} 条未包含：{事件}（{n} 国样本在报）`；传播文案用事实句：`12 国样本在报，德国前 15 条没有` | 说清"样本"与"前 N 条"即可自证口径；传播句是可直接核验的事实陈述，不是推断 | ①"未报道"（断言过强）；②"沉默/封锁/审查"（推断 + 政治指控，且几乎必然被截图放大） |
| D22 | 中文语义审读 | **需要一次**，范围限定于 `/about`、未包含行、分享文案三处；产出 `docs/copy-review.md` | 只审对外可见的 3 处，成本 1 小时；全站审读性价比低 | 全站审读（收益递减） |
| D23 | 突变/偏移的"上一次"口径 | 固定为**同日相邻 slot**（00:00 的对比对象是前一天 14:00），并在 tooltip 写明对比的 slot | 两次快照间隔 10h / 14h 不等，不写明会产生"昨天 vs 今天"的误解 | "昨天同一时段"（部分 slot 缺失时没有对比对象） |
| D24 | 失败计数的告警阈值 | 连续 3 次失败 → 告警；连续 3 次后仍失败 → 自动切 fallback 并标注 | 一次失败多为抖动，三次才说明源有问题 | 首次失败即切 fallback（fallback 质量通常更差） |
| D25 | 链接策略（v1.3） | 链接必须**解码到发布方真实域名**；解码失败则该条**不渲染为链接**，只显示来源名。发布物中禁止出现 `news.google.com` 链接 | 大陆点 Google 中转链接 100% 失败；能否解码直接决定一条标题有没有出口。解码率目标从 80% 提高到 **95%** | ①保留 Google 链接（必挂）；②只给来源名不给链接（信息量下降但可接受，作为失败兜底） |
| D26 | 外媒本身不可达 | **不做构建期可达性探测**；链接旁标来源域名，关于页说明"部分来源可能需要可访问境外网络"。不为用户提供、也不引导任何绕过手段 | 构建环境（海外 CI）的可达性不等于用户环境，探测结论必然失真；这属于用户网络条件，产品不该假装能解决 | ①构建期探测可达性（结论不可信）；②全部去除外链（产品失去出口）；③内嵌镜像/全文（版权与合规双重风险） |
| D27 | 对外文案（v1.3） | 一句话定位改为「**今天 15 国都在报什么**」。界面继续用"本期前 N 条未包含"；**传播语禁用"谁在沉默/谁在封锁/审查"** | 面向大陆受众时，"沉默"类表述属推断且会在平台侧触发风险，反而让内容传不出去 | ①保留"谁在沉默"（传播风险最高）；②中性到"15 国头条对比"（无记忆点） |
| D28 | 内容筛查（v1.4） | **簇级剔除 + 指标计算前 + 回补到 15 条**；引擎在仓库、词条归运营者（`sensitive.local.json` 不入库）；默认 0 条 hard 规则 | 按条剔除会让"未包含"变成错误指控（剔了德国那一条，页面就说德国没报）；先算指标再删会让所有数字与展示不一致 | ①条级剔除（会造假）；②人工全量审核 45 条/次（撑不住 2 次/日）；③不做筛查（平台风险） |
| D29 | 筛查模式（v1.4） | 默认 `SCREEN_MODE=review`：有 soft 命中就不自动发布，等人工确认；规则稳定后切 `auto`。hard 命中任何模式都自动剔除 | 上线初期规则必然不准，宁可少发一期也不要发错一期；稳定后人工成本必须降下来，否则项目会死于运营 | ①一开始就 auto（规则没调准就放出去）；②永远 review（每 12 小时一次人工，不可持续） |

**决议的生效方式**：以上为 V1 实现基线。任何一条改动都会影响数据契约或验收标准，必须同步修改本节、受影响章节，并升 `algorithmVersion`（若涉及指标）或在前端加变更说明（若涉及文案）。

---

## 3. 系统架构

### 3.1 组件图

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Actions (cron 0 6,16 * * *, workflow_dispatch)        │
│                                                             │
│  run.mjs                                                    │
│   ├─ 1. loadFeeds()        读 src/config/feeds.json          │
│   ├─ 2. fetchAll()         15 国并发 5，重试/超时/健康记录    │
│   ├─ 3. normalize()        清标题、解链接、语言、国内去重      │
│   ├─ 4. embed()            多语言向量（本地 ONNX，缓存）       │
│   ├─ 5. cluster()          跨国家配对 → 并查集 → 事件簇        │
│   ├─ 6. lineage()          与最近 7 天簇匹配 → 连续/突变       │
│   ├─ 7. topics()           主题软分类 → 国家分布               │
│   ├─ 8. metrics()          共识/未包含/共识条/偏移/时间标记     │
│   ├─ 9. translate()        仅翻展示文本 ≤61 条（§7.5）          │
│   ├─ 10. validate()        JSON Schema 校验                   │
│   ├─ 11. write()           snapshots(latest/previous) + state + status   │
│   └─ 12. render()          dist/*.html                        │
│                                                             │
│  commit: data/ (bot)                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  Cloudflare Pages (静态托管)
                  /  /status  /about
```

> **v1.4 补充**：截图里是 v1.2 的步骤序号。实际顺序在 3→4 之间插入「筛查标记」，在 5 之后插入「簇级裁决 + 回补到 15 条」，详见 §7.6.2。编号不重排以免全文交叉引用失效。

### 3.2 运行时序（单次）

```
T+0s    读取配置，校验 15 国
T+0s    并发抓取（上限 5），单请求 10s 超时，最多 3 次尝试
T+15s   清洗、语言识别、链接解码、国内去重
T+20s   批量向量化 225 条（首次需下载模型，CI 缓存后 <10s）
T+30s   配对与聚类（约 2.5 万对，纯内存）
T+32s   主题分类、历史匹配
T+35s   计算标记（含 topConsensus）
T+38s   翻译展示文本 ≤61 条（缓存命中约 1s；冷启动一次批量调用约 2–4s）
T+42s   校验 Schema
T+45s   写文件、渲染 HTML
T+60s   git commit & push（触发 Pages 构建）
```

预算：单次 < 3 分钟；Actions 上限设为 10 分钟。翻译不可用时直接跳过该步（T+38s → T+42s），不重试等待。

### 3.3 部署拓扑（v1.3：一套产物、双托管）

**面向大陆用户，托管是一等公民，不是运维细节。**

```
                    ┌──────────────────────────────┐
                    │  GitHub Actions（海外）       │
                    │  抓取 → 计算 → 翻译 → 渲染     │
                    └──────────────┬───────────────┘
                                   │ 同一份 dist/
              ┌────────────────────┴────────────────────┐
              ▼                                          ▼
  ┌───────────────────────┐                  ┌────────────────────────┐
  │ 主站：Cloudflare Pages │                  │ 镜像：阿里云 OSS + CDN   │
  │ + 自定义域名（必须）    │                  │ 需备案域名（可选）        │
  │ 全球可达，大陆不稳定    │                  │ 大陆稳定，需备案与审核     │
  └───────────────────────┘                  └────────────────────────┘
```

- 仓库：`main` 存代码与 `data/`；**`dist/` 不入库**，由 CI 构建一次、同时投递到两个托管目标（避免"两套产物"这一类经典事故）。
- **主站**：Cloudflare Pages，构建命令 `npm run build`，输出 `dist`；**必须绑自定义域名 + 强制 HTTPS**，`*.pages.dev` 仅用于开发自测，不用于对外分发（D20）。
- **镜像（可选）**：阿里云/腾讯云 OSS + CDN，需备案域名。只有一个新增步骤：`npm run deploy:cn` 把 `dist` 同步到桶并刷新 CDN。域名备案下来之前不启用。
- **不做的**：不做服务端、不做数据库、不做动态回源。镜像只是静态文件同步，不引入第二个数据源。
- 密钥：翻译密钥放 GitHub Secrets；OSS 同步用子账号 AccessKey，作用域限制到该桶，不进入构建产物。
- **发布前的硬检查**（`npm run preflight`）：产物中不得出现 `news.google.com` 的 `href`；所有外链必须是 `https://`。

---

## 4. 目录结构

```
world-headlines-snapshot/
├─ package.json
├─ package-lock.json
├─ .nvmrc                        # 20
├─ .gitignore
├─ src/
│  ├─ config/
│  │  ├─ feeds.json              # 唯一人工维护的国家/源配置
│  │  ├─ topics.json             # 11 主题 × 8 英文锚点
│  │  ├─ entities.json           # 约 500 个高频实体及多语言别名
│  │  └─ overrides.json          # 人工覆盖：隐藏某条/修正标签（可选）
│  ├─ lib/
│  │  ├─ constants.mjs           # §5.8 全部阈值，唯一出处
│  │  ├─ fetch.mjs               # HTTP、重试、解析 RSS
│  │  ├─ clean.mjs               # 标题清洗、发布方剥离
│  │  ├─ links.mjs               # Google News 链接解码
│  │  ├─ lang.mjs                # 语言识别
│  │  ├─ embed.mjs               # ONNX 向量化 + 缓存
│  │  ├─ dedupe.mjs              # 国内去重
│  │  ├─ cluster.mjs             # 相似度、并查集
│  │  ├─ topics.mjs              # 主题软分类
│  │  ├─ history.mjs             # 快照读写、lineage
│  │  ├─ metrics.mjs             # 四个标记 + topConsensus
│  │  ├─ translate.mjs           # 机翻调用、缓存、配额守卫（§7.5）
│  │  ├─ schema.mjs              # Ajv 校验
│  │  └─ util.mjs                # 时间、哈希、转义
│  ├─ scripts/
│  │  ├─ run.mjs                 # 主流程
│  │  ├─ render.mjs              # 生成 dist
│  │  ├─ probe-feeds.mjs         # 上线前源探测
│  │  ├─ calibrate.mjs           # 阈值校准
│  │  └─ translate-once.mjs      # 手动补翻/预填缓存，日常由 run.mjs 调用
│  └─ site/
│     ├─ templates/              # index / status / about / card
│     ├─ styles.css
│     ├─ app.js                  # 筛选、倒计时、译文切换（< 4 KB）
│     └─ flags.svg               # 15 面简化国旗 sprite
├─ data/
│  ├─ snapshots/
│  │  ├─ latest.json             # 完整快照（§5.3）
│  │  └─ previous.json           # 上一份，供突变比较
│  ├─ latest.json                # 最新快照副本，供外部消费（§5.4）
│  ├─ status.json
│  ├─ state/
│  │  ├─ clusters.json           # eventId → firstSeen/lastSeen/seenDates/lastTitles
│  │  └─ history.json            # 最近 14 个 slot 的精简摘要（§5.6）
│  └─ cache/
│     ├─ links.json              # Google News 链接解码缓存（§6.4）
│     ├─ embeddings.json         # 标题 SHA-256 → 向量（§8.1）
│     └─ translations.json
├─ dist/                         # 构建产物，提交以支持无构建托管
├─ tests/
│  ├─ fixtures/
│  │  ├─ feeds/                  # 15 份真实 RSS 响应
│  │  ├─ snapshots/              # 3 天合成快照
│  │  └─ labeled-pairs.jsonl     # 300 对人工标注相似度
│  ├─ unit/*.test.mjs
│  ├─ render/*.test.mjs
│  └─ e2e/*.spec.mjs
├─ docs/
│  ├─ 01-feasibility-review.md
│  └─ 02-detailed-design.md
└─ .github/workflows/snapshot.yml
```

---

## 5. 数据契约

### 5.1 `src/config/feeds.json`

```json
{
  "schemaVersion": "1.0",
  "countries": [
    {
      "code": "DE",
      "name": "德国",
      "nameEn": "Germany",
      "flag": "flag-de",
      "region": "europe",
      "lang": "de",
      "order": 6,
      "limit": 15,
      "source": {
        "type": "google-news",
        "hl": "de",
        "gl": "DE",
        "ceid": "DE:de",
        "url": "https://news.google.com/rss?hl=de&gl=DE&ceid=DE:de"
      },
      "fallback": {
        "type": "direct-rss",
        "name": "Spiegel",
        "url": "https://www.spiegel.de/schlagzeilen/index.rss"
      },
      "enabled": true
    }
  ]
}
```

规则：

- `code` 为 ISO 3166-1 alpha-2，全站唯一。
- `limit` 为该国保留的样本条数（默认 15，见 §7.4）。它是**样本口径**，不是展示条数；改动它会使历史快照不可比，必须同时升 `algorithmVersion` 并重算偏移分位。
- `url` 由代码根据 `hl/gl/ceid` 生成，禁止在配置里重复写死（避免不一致）。
- `fallback` 为候选值，必须在 `probe-feeds.mjs` 中验证后才可启用。
- 新增/删除国家只改此文件；前端自动适配。
- `order` 决定卡片顺序：先按 `region` 顺序，再按 `order`。

### 5.2 15 国配置表（`ceid` 需上线前验证）

| 地区 | 国家 | code | hl | gl | ceid | 语言 |
|---|---|---|---|---|---|---|
| 美洲 | 美国 | US | en-US | US | US:en | en |
| 美洲 | 巴西 | BR | pt-BR | BR | BR:pt-419 | pt |
| 美洲 | 加拿大 | CA | en-CA | CA | CA:en | en |
| 美洲 | 墨西哥 | MX | es-419 | MX | MX:es-419 | es |
| 欧洲 | 英国 | GB | en-GB | GB | GB:en | en |
| 欧洲 | 德国 | DE | de | DE | DE:de | de |
| 欧洲 | 法国 | FR | fr | FR | FR:fr | fr |
| 欧洲 | 意大利 | IT | it | IT | IT:it | it |
| 欧洲 | 西班牙 | ES | es | ES | ES:es | es |
| 亚洲 | 日本 | JP | ja | JP | JP:ja | ja |
| 亚洲 | 韩国 | KR | ko | KR | KR:ko | ko |
| 亚洲 | 印度 | IN | en-IN | IN | IN:en | en |
| 亚洲 | 印尼 | ID | id | ID | ID:id | id |
| 大洋洲 | 澳大利亚 | AU | en-AU | AU | AU:en | en |
| 非洲 | 南非 | ZA | en-ZA | ZA | ZA:en | en |

> 巴西/墨西哥使用 `es-419`、`pt-419` 形式的地区码；若返回空，回退 `BR:pt-BR`、`MX:es` 并记录到状态页。印度仅有英文版；如需印地语可后续增加 `IN:hi` 作为第二个样本（会改变"每国一个源"的口径，V1 不做）。

#### 5.2.1 备用池（D16：替换国家，不缩减国家数）

| 备用国 | code | hl / gl | ceid | 语言 | 补位理由 |
|---|---|---|---|---|---|
| 阿根廷 | AR | es-419 / AR | AR:es-419 | es | 南锥体，与巴西/墨西哥形成拉美三角 |
| 波兰 | PL | pl / PL | PL:pl | pl | 中东欧，斯拉夫语系，欧洲第 6 国 |
| 土耳其 | TR | tr / TR | TR:tr | tr | 欧亚交界，议程与欧盟常有分歧 |
| 越南 | VN | vi / VN | VN:vi | vi | 东南亚第二国，与印尼互补 |
| 尼日利亚 | NG | en-NG / NG | NG:en | en | 非洲人口第一国，与南非互补 |

**替换规则**（`probe-feeds.mjs` 与 `run.mjs` 共同遵守）：

1. 某国连续 **3 次** `itemsValid < MIN_ITEMS_FULL`（12），或连续 3 次抓取失败且无可用 fallback → 进入替换候选。
2. 从备用池按上表顺序取第一个未启用的国家，**一次只换一个**，并在 `status.json` 记一条 `changes` 记录（时间、被换下、换上、原因）。
3. 换国后**必须重跑 `calibrate`**（语言与国别分布变化会影响阈值）并升 `algorithmVersion`。
4. `countriesConfigured` 始终为 15：换国不改变分母口径，避免"分母悄悄变成 14"。
5. 被换下的国家不删除配置，只置 `enabled:false` 并保留其历史，便于回滚。

### 5.3 快照 `data/snapshots/latest.json`、`previous.json`

只保留两份完整快照（v1.1 起，见 §5.9）。`slot` 字段承载时间标识（UTC，`2026-10-28T06:00:00.000Z`），文件名不再带时间戳；每次运行把旧 `latest.json` 改名为 `previous.json` 后覆盖写入。14 份历史聚合信息见 §5.6。

```json
{
  "schemaVersion": "1.0",
  "algorithmVersion": "1.0.0",
  "model": { "name": "Xenova/multilingual-e5-small", "revision": "sha256:...", "quantized": true },
  "generatedAt": "2026-10-28T06:03:21.000Z",
  "slot": "2026-10-28T06:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "stats": {
    "countriesConfigured": 15,
    "countriesValid": 14,
    "countriesFailed": 1,
    "itemsRaw": 218,
    "itemsAfterDedupe": 205,
    "clusters": 96,
    "degraded": true,
    "degradedReasons": ["ZA:items_below_minimum"]
  },
  "topConsensus": {
    "eventId": "evt_01J9Z6K3",
    "label": "National election recount",
    "labelZh": "全国选举重新计票",
    "reportingCountries": 13,
    "reportingCodes": ["US", "GB", "FR", "JP", "DE", "IT"],
    "cohesion": 0.88
  },
  "countries": [
    {
      "code": "DE",
      "name": "德国",
      "region": "europe",
      "status": {
        "ok": true,
        "usedFallback": false,
        "httpStatus": 200,
        "latencyMs": 412,
        "itemsFetched": 15,
        "itemsValid": 15,
        "stale": false,
        "fetchedAt": "2026-10-28T06:03:05.000Z",
        "consecutiveFailures": 0,
        "error": null
      },
      "items": [
        {
          "rank": 1,
          "eventId": "evt_01J9Z6K3",
          "clusterId": "cl_20261028T0600_014",
          "titleOriginal": "Opposition gewinnt knapp",
          "titleDisplay": "反对党以微弱优势获胜",
          "lang": "de",
          "translation": {
            "provider": "deepl",
            "target": "zh-CN",
            "title": "反对党以微弱优势获胜",
            "reviewed": false
          },
          "publisher": "Spiegel",
          "url": "https://www.spiegel.de/politik/...",
          "googleUrl": "https://news.google.com/rss/articles/...",
          "linkDecoded": true,
          "publishedAt": "2026-10-28T04:12:00.000Z",
          "publishedAtSource": "rss",
          "consensusCount": 12,
          "consensusRatio": 0.857,
          "isUnique": false,
          "consecutiveDays": 3,
          "matchConfidence": 0.86,
          "topic": "politics",
          "topicConfidence": 0.71
        }
      ],
      "displayItems": ["evt_01J9Z6K3"],
      "silentEvent": {
        "eventId": "evt_01J9Z5QW",
        "label": "National election recount",
        "labelZh": "全国选举重新计票",
        "reportingCountries": 12,
        "reportingCodes": ["US", "GB", "FR", "JP"],
        "threshold": 6,
        "confidence": 0.81,
        "partialSample": false
      },
      "agendaOffset": {
        "value": 0.134,
        "band": "clear",
        "percentile": 0.93,
        "note": "更关注经济，较少关注冲突",
        "topRise": [{ "topic": "economy", "delta": 0.18 }],
        "topFall": [{ "topic": "conflict", "delta": -0.14 }]
      },
      "suddenShift": {
        "isShift": true,
        "setDistance": 0.74,
        "topicDistance": 0.16,
        "comparedTo": "2026-10-27T1600Z"
      }
    }
  ]
}
```

字段约束：

- `url` 必须是 `https?://`；解码失败时 `linkDecoded=false` 且 `url` 仍是 Google 链接。
- `titleDisplay` 无翻译时等于 `titleOriginal`。
- `consensusCount` 只统计 `stats.countriesValid` 中的国家；同国多条只计 1。
- `displayItems` 固定最多 3 个 `eventId`，按 `rank` 升序。
- `topConsensus` 可为 `null`。仅在 `reportingCountries >= max(TAU_MIN, ceil(0.6 × denominator))` 且 `cohesion >= COHESION_MIN` 时输出；为 `null` 时首页整个共识条区块不渲染（不留空壳）。该条**不带链接**（D18）。
- `silentEvent` 可为 `null`；不满足条件时必须为 `null`，不能输出空字符串。
- `agendaOffset` 在样本不足时为 `null`。
- `suddenShift` 在无上一次快照或任一侧不健康时为 `null`。
- 所有时间为 UTC ISO 8601，带 `Z`。

### 5.4 `data/latest.json`

与最新快照内容完全一致（同一对象序列化），便于前端/外部消费。**不是指针**，避免多一次请求。

### 5.5 `data/status.json`

```json
{
  "schemaVersion": "1.0",
  "updatedAt": "2026-10-28T06:03:21.000Z",
  "overall": "yellow",
  "nextRunAt": "2026-10-28T16:00:00.000Z",
  "resources": {
    "translationCharsThisMonth": 48210,
    "translationCharsLimit": 400000,
    "translationProvider": "deepl",
    "modelCacheHit": true
  },
  "changes": [],
  "countries": [
    {
      "code": "ZA",
      "name": "南非",
      "ok": false,
      "httpStatus": 503,
      "itemsFetched": 0,
      "latencyMs": 10000,
      "lastSuccessAt": "2026-10-28T16:02:40.000Z",
      "consecutiveFailures": 1,
      "usedFallback": false,
      "stale": true,
      "note": "RSS timeout"
    }
  ]
}
```

`overall` 规则：

- `green`：全部国家 `ok` 且 `itemsFetched ≥ 12`。
- `yellow`：1–2 国失败，或任一国家 `itemsFetched < 10`。
- `red`：≥3 国失败，或 `countriesValid < 10`。

`resources`：配额与运维观察字段。`translationCharsThisMonth` 每月 1 日归零；超过 `translationCharsLimit` 时**停止调用翻译**并回退原文（§7.5），宁可不翻也不要月中被供应商掐断。

`changes`：国家替换记录，格式 `{ "at": "...", "out": "ZA", "in": "NG", "reason": "items_below_minimum" }`，规则见 §5.2.1，`/status` 与 `/about` 均需展示。

### 5.6 `data/state/history.json`（替代 v1.0 的 `history-index.json`）

保留最近 14 个 slot 的精简摘要，供偏移分位、突变、连续天数使用：

```json
{
  "schemaVersion": "1.0",
  "slots": [
    {
      "slot": "2026-10-28T06:00:00.000Z",
      "validCountries": 14,
      "totalItems": 205,
      "countries": {
        "DE": {
          "itemsValid": 15,
          "eventIds": ["evt_01J9Z6K3", "evt_01J9Z5QW"],
          "topicDist": { "conflict": 0.12, "politics": 0.31, "economy": 0.22 },
          "jsd": 0.134
        }
      }
    }
  ]
}
```

写入时按 `slot` 去重、超过 14 条从最旧删除。**不存标题、不存链接**，只存计算所需的最小状态，因此可以长期留在 git 历史里。

### 5.7 `data/state/clusters.json`

```json
{
  "schemaVersion": "1.0",
  "events": [
    {
      "eventId": "evt_01J9Z5QW",
      "firstSeenAt": "2026-10-25T06:00:00.000Z",
      "lastSeenAt": "2026-10-28T06:00:00.000Z",
      "seenDates": ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"],
      "lastTitles": [
        "National election recount ordered",
        "Recount begins in three states",
        "Court sets recount deadline"
      ],
      "lastCountryCount": 12
    }
  ]
}
```

只保留 7 天内出现过的簇；`eventId` 一旦分配不再改变。

### 5.8 全局阈值常量表（唯一出处）

v1.0 草稿里同一件事出现了三个门槛（§9.2 写 12、§10.2 写 15、§13 写 15），实现时必然分叉。以下表格是**唯一出处**，代码里必须从 `src/lib/constants.mjs` 引用，禁止就地写字面量。

| 常量 | 值 | 含义 | 低于/不满足时的行为 |
|---|---|---|---|
| `MIN_ITEMS_VALID` | 10 | 进入共识分母的最低条数 | 该国不参与共识分母与跨指标计算，卡片标"样本不足" |
| `DENOM_MIN` | 10 | 有效国家数下限 | 关闭"未包含"；共识仍计算但标 `provisional` |
| `MIN_ITEMS_TOPIC` | 12 | 计算主题分布的最低条数 | `agendaOffset = null` |
| `MIN_ITEMS_FULL` | 12 | 输出"未包含"的最低条数 | `silentEvent = null` |
| `TAU_RATIO` / `TAU_MIN` | 0.4 / 6 | 未包含所需在报国家数 | `tau = max(6, ceil(0.4 × denominator))` |
| `COHESION_MIN` | 0.72 | 簇凝聚力下限 | 不输出"未包含"，共识计数标低置信 |
| `T_MATCH` | 0.80（待校准） | 事件合并阈值 | 见 §8.3 / §16.2 |
| `LINEAGE_SIM` | 0.85 | 跨快照簇继承相似度 | 分配新 `eventId` |
| `LINEAGE_JACCARD` | 0.5 | 跨快照国家集合重合度 | 分配新 `eventId` |
| `SHIFT_SET` | 0.70 | 突变的事件集合差异 | 不标突变 |
| `SHIFT_TOPIC` | 0.12 | 突变的主题差异 | 不标突变 |
| `OFFSET_T1` / `OFFSET_T2` | 0.05 / 0.12 | 偏移分档地板 | 历史不足时使用，`provisional=true` |
| `CONSECUTIVE_TAG` | 3 | 显示"连续 N 天"的天数 | 不显示 |
| `RETENTION_SLOTS` | 14 | `state/history.json` 保留的 slot 数（7 天 × 2；完整快照只留 2 份，见 §5.9） | 超出从最旧删除 |
| `DISPLAY_ITEMS` | 3 | 每国展示条数 | — |
| `CANDIDATE_POOL_EXTRA` | 10 | 抓取时每国多留的候选条数（`limit + 10 = 25`），供簇级筛查剔除后回补（§7.6.2） | 取 0 则无法回补，样本会缩水 |
| `MAX_SOFT_HITS` | 5 | 单次运行 soft 命中数上限 | 超出则告警"规则可能过宽"，但仍按模式处理 |
| `SCREEN_MODE` | `review`（环境变量，默认） | `review` / `auto`，见 §7.6.3 | 非法值按 `review` 处理（更安全的一侧） |

改任一常量都必须升 `algorithmVersion`，否则历史快照的偏移分位与连续天数会静默失真。

### 5.9 仓库体积策略（v1.0 遗漏）

v1.0 计划"每次提交 14 份完整快照 + dist"。按每份约 150–250 KB 估算，每天 2 次提交在 git 历史中不可回收，一年约 110–180 MB，三年会逼近 GitHub 建议上限；删除旧文件只删工作区，不删历史。

修正：

- **完整快照只保留最新 2 份**（当前与上一份，供突变比较），文件名 `snapshots/latest.json`、`snapshots/previous.json`。
- 历史所需信息写入**精简状态文件** `data/state/history.json`，只存 lineage 与分位计算必需的字段：`eventId`、`seenDates`、`lastTitles`、`countryCodes`、各国 `countryTopicDist`（11 个 float）、`jsd`。单份约 15–30 KB。
- 需要"回看某天页面"时（V3），从 `dist/history/` 的静态产物取，不依赖 git 历史。
- `.gitattributes` 对 `data/state/*.json` 关闭 diff 以外的处理；提交信息固定 `chore(data): snapshot <slot>`，便于必要时按脚本压缩历史。

结果：单次提交约 40–70 KB，一年约 30–50 MB，可长期运行。

---

## 6. 抓取层设计

### 6.1 接口

```js
// src/lib/fetch.mjs
export async function fetchCountry(country, opts) 
// → { items: RawItem[], status: CountryStatus, usedFallback: boolean }

export async function fetchAll(config, { concurrency = 5 } = {})
// → { results: Map<code, CountryResult>, stats }
```

`RawItem`：`{ title, link, publisher, pubDate, guid }`。

### 6.2 规则

| 项 | 取值 |
|---|---|
| 超时 | 连接 5s / 总 10s |
| 重试 | 最多 3 次，退避 1s / 3s / 7s；仅对 5xx、429、超时、网络错误重试 |
| 并发 | 全局 5 |
| UA | `WorldHeadlinesSnapshot/1.0 (+https://example.com/about; contact@example.com)` |
| Accept | `application/rss+xml, application/xml;q=0.9, */*;q=0.1` |
| 跟随跳转 | 最多 3 跳；检测 consent/`/sorry/` 页面并视为失败 |
| 响应大小 | 上限 2 MB |
| 编码 | 先按 `Content-Type`，再按 XML 声明，最后 UTF-8；错误则 iconv 兜底 |

失败处理顺序：

1. 主源失败 → 若配置了 `fallback` 且启用 → 抓 fallback，`usedFallback=true`，状态页标黄。
2. 仍失败 → 若本地存在 7 天内同一国家的最近成功快照 → 复用其条目，`status.stale=true`，页面该卡片显示"数据陈旧 · 上次 10-27 22:03"。
3. 仍无数据 → 该国家 `ok=false`，卡片显示占位与"本期抓取失败"，不参与任何标记计算。

### 6.3 解析

- 用 `fast-xml-parser`，禁止实体展开（防 XXE / billion laughs），`processEntities: false`。
- 读取 `rss.channel.item[]`；兼容 `item` 为单对象的情况。
- `publisher`：优先 `<source>` 文本；否则从标题后缀 ` - X` 剥离；否则为 `未知来源`。
- `pubDate`：`new Date()` 解析；非法则置 `null`，`publishedAtSource="missing"`，排序回退到 RSS 顺序。
- `guid`：`guid` 或 `link`，用于幂等去重。

### 6.4 链接解码

Google News 链接有两类：

- 旧格式 `/rss/articles/CBMi...`：base64 载荷内含原始 URL，可本地解码。
- 新格式 `/rss/articles/AU_yqL...`：需要请求 Google 的内部接口才能还原，且格式会变。

策略（`src/lib/links.mjs`）：

```
decodeGoogleNewsUrl(link):
  1. 若 link 不是 news.google.com → 直接返回
  2. 尝试旧格式 base64 解码，校验结果以 http(s) 开头 → 返回
  3. 尝试对 link 发 HEAD（redirect: manual），若 Location 指向非 Google 域名 → 返回
  4. 均失败 → 返回 { url: link, decoded: false }
```

- 单次运行最多 15 个 HEAD，只在步骤 2 失败时执行。
- 解码结果缓存到 `data/cache/links.json`（按链接哈希），7 天过期。
- **解码率目标 95%（v1.3 从 80% 上调）**：大陆用户对 Google 中转链接是 100% 失败，所以"解码失败"约等于"这条标题没有出口"。
- **解码失败的渲染规则**：`linkDecoded=false` 的条目不渲染成链接，只显示标题 + 来源名 + 时间（D25）。前端不得同时存在"看起来可点但点开必挂"的链接——那比没有链接更伤。
- **`preflight` 硬校验**：构建产物中若出现 `href="*news.google.com*"` 直接失败退出，不允许发布。
- 状态页统计解码率与 HEAD 成功率；解码率 < 95% 时提示升级解码器（新格式需要 `batchexecute` 接口，见 §6.4.1）。

#### 6.4.1 新格式（`AU_...`）解码——本项目最脆的外部依赖

v1.3 起这不再是"可选优化"，而是**发布阻断项**：大陆用户点了 Google 中转链接必然失败，所以解码必须成功。

处理顺序：

1. **旧格式离线解码**（首选）：纯本地 base64 提取，零网络、零失败率，前提是 Google 仍返回旧格式。
2. **HEAD 跳转**：`redirect: manual`，看 `Location` 是否指向非 Google 域名。每国限 3 次，只在旧格式失败时执行。
3. **`batchexecute` 接口还原**：新格式需要 POST 到 `news.google.com/_/DotsSplashUi/data/batchexecute`，带 `f.req` 载荷与 `Signature`/`Timestamp`，参数由页面内联脚本生成。**该接口无文档、随时可变，且请求次数多**。仅在探测显示新格式占比 > 20% 时才实现，并封装在 `links-new.mjs` 里，失败一律降级。
4. **全部失败**：该条不可点，只显示来源名（D25）。

**为什么把它列为最高风险**：整条链路里只有这一步依赖 Google 的非公开行为，且它的失败会直接让"每条都能跳原文"这个卖点归零。所以：

- `probe-feeds.mjs` 的第一职责就是**量出新旧格式占比与旧格式解码率**（见报告第 3 节）。
- 若旧格式占比 < 80%，说明必须做第 3 步，工期与风险都要重估。
- 若第 3 步也不稳，产品退化为"标题 + 来源名，不可点"。这仍可交付——因为 D11 已把内容自包含定为前提，跳转只是附加动作。

**2026-10-28 首次真实探测结果（重要）**：696/696 条链接都是 `CBMi` 前缀，但**第 1 步离线解码率 0%**。这基本可以确认：`CBMi` 前缀已经不能作为"可离线解码"的判据，它现在只是**外层包装**，载荷里是 `AU_` token 而非明文 URL。

后果：

- `classifyLink` 的"`CBMi` → 旧格式"映射是错的，必须升级为四态：明文可解 / `CBMi` 包装 `AU_` / 直接 `AU_` / 无法识别（`src/lib/rss.mjs` 的 `extractInnerToken` 已实现）。
- 第 1 步从"首选"降为"仅覆盖历史链接"，主路径变成第 3 步 `batchexecute`。
- 若 `batchexecute` 不可靠，按 D25 全部不渲染为链接。这时产品仍成立，但"点开原文"归零，必须在关于页如实说明。

---

### 6.5 幂等与并发锁

- workflow 使用 `concurrency: { group: snapshot, cancel-in-progress: false }`。
- 若当前 `slot` 已有快照且未超过 5 分钟，脚本直接退出 0，避免重复写入。
- 手动 dispatch 可传 `force=true` 覆盖。

---

## 7. 归一化与去重

### 7.1 标题清洗（`clean.mjs`）

```js
export function cleanTitle(raw, publisher) {
  let t = raw.normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (publisher && t.endsWith(` - ${publisher}`)) {
    t = t.slice(0, -(publisher.length + 3)).trim();
  }
  return t;
}
```

- 仅用于匹配时转小写；展示保留原大小写与标点。
- `cleanTitle` 本身不翻译、不改写、不删减标题内容；翻译在 §7.5 单独进行，且只影响展示，不回写 `titleOriginal`。

### 7.2 语言识别（`lang.mjs`）

- 使用 `franc-min`，输入长度 < 20 字符时回退到配置的 `lang`。
- 结果写入 `item.lang`；与配置不一致不报错，仅记录。
- 语言影响：译文目标、字体 `lang` 属性、分词。

### 7.3 国内去重（`dedupe.mjs`）

同一国家内，满足任一条件视为重复：

- 相同 `publisher` 且标题 token Jaccard ≥ 0.80；
- 向量余弦 ≥ 0.92。

保留规则：RSS 顺序更靠前者；若同分，保留 `pubDate` 更晚者。**去重不补位**：不把已判为重复的条目放回以凑满 15 条，否则"共识"会被同源重复项撑大；实际条数如实记入 `itemsValid` 并触发 §13 的降级。

**为什么重要**：Google News 是聚合器，同一事件可能来自同一媒体的多个栏目。不去重会把"共识"撑大，也会让"每国 15 条"失真。

### 7.4 条目截断（v1.0 未定义的关键步骤）

"每国抓 15 条"是全部四个标记的分母基础，但 v1.0 全文没有说明这 15 条在哪一步产生。Google News RSS 一次可能返回数十条，必须显式截断，否则：

- 样本口径随机漂移，偏移分位与连续天数无法跨天比较；
- 沉默判断的"前 N 条"没有确定含义。

规则（`normalize()` 的最后一步）：

```
1. 解析 RSS 全部条目 → itemsRaw（可能是 20–100 条，不假设上限）
2. 按 RSS 文档顺序保留（Google News 的排序本身就是热度序，不要自己重排）
3. 国内去重（§7.3）→ itemsAfterDedupe
4. 取前 limit 条（`feeds.json` 的 `limit`，默认 15）→ itemsValid
5. itemsValid 可能小于 limit：此时不补位，如实记录并降级
```

- 只用 `itemsValid` 参与聚类、共识、偏移、连续天数计算。
- `stats.itemsRaw` 记录解析总数（用于发现 RSS 返回结构变化：若某国突然从 60 条降到 12 条，多半是格式变了而不是新闻变少）。
- 截断**在去重之后**：先去重再取 15，避免前 15 条里 6 条是同一条新闻。
- `limit` 变更属于样本口径变更，必须升 `algorithmVersion`（见 §5.8）。

### 7.5 标题机翻管线（D13–D15）

**翻译只服务展示，不参与任何指标计算。** 聚类、共识、偏移全部使用原文与多语言向量，因此翻译质量波动不会污染数据。

**翻译范围（写死，不允许扩大）**：

| 内容 | 条数/次 | 说明 |
|---|---|---|
| 展示标题 | ≤ 45（15 国 × 3） | 仅 `displayItems` 命中的条目 |
| 未包含事件标签 | ≤ 15 | 每国最多 1 条 |
| 共识条标签 | ≤ 1 | `topConsensus` |
| 合计 | **≤ 61** | 225 条全量翻译是 3.7 倍成本且无任何指标收益 |

**调用顺序与降级**：

```
translateAll(texts):
  1. 查缓存（sha256(title + target + providerVersion)）→ 命中直接返回
  2. 未命中的批量送 DeepL Free（api-free.deepl.com，每请求 ≤50 条，target_lang=ZH）
  3. DeepL 失败/超配额 → 整批改用 Workers AI `@cf/meta/m2m100-1.2b`
  4. 两者都不可用 → 该条 translation=null，前端回退原文，快照记 degradedReasons += translation_unavailable
```

**配额测算**：≤61 条 × 平均 60 字符 ≈ 3,700 字符/次；每月 60 次 ≈ 22 万字符，低于 DeepL Free 的 50 万字符/月。缓存命中后（热点事件、连续多天的同一事件）实际调用通常低于 8 万字符/月。**必须实现计数器**：`status.json` 记录本月已用字符数，超过 40 万即停止调用、全量降级为原文，宁可没译文也不要月中被掐断。

**缓存与失效**：`data/cache/translations.json`，key 含 `providerVersion`（如 `deepl:2`）。切换供应商不覆盖旧译文，实现"回滚即切回旧版本"。

**质量与合规约束**：

- 译文只用于展示，**不得**被当作事件标签做二次匹配（`labelZh` 仅展示用，聚类仍用 `label`/原文）。
- 关于页必须写明"标题由机器翻译，仅供参考，原文以链接为准"。
- 不翻译摘要——我们本来就不存摘要（§15）。
- 术语表：国家名、常见机构名（EU/UN/NATO）走固定映射，不送翻译，避免"法兰克福汇报"被译成奇怪写法。

**失败时的产品行为**：某国全部条目译文缺失 → 该卡片只显示原文并加 `lang` 属性，不显示空的中文行；不允许出现"标题为空"的卡片。

---

### 7.6 内容筛查（D28/D29）

面向大陆用户，"发布前检查是否有敏感内容"是必需环节。但**如果做错，会让产品最核心的结论变成假的**，所以执行层级必须钉死。

#### 7.6.1 三条不可协商的约束

| 约束 | 规则 | 做错的后果 |
|---|---|---|
| **簇级，不是条级** | 一个事件簇里任一条命中，整簇在所有国家一起剔除 | 只剔某国那一条 → 页面显示"这件事 12 国在报，该国前 15 条没有"，而该国其实报了。**产品自己制造一条错误指控**，比不做筛查更糟 |
| **在指标计算之前** | 筛查位于「分簇」之后、「共识/未包含/偏移计算」之前 | 先算指标再删条目 → 所有数字与页面展示不一致，且无法复核 |
| **剔除后回补** | 从 rank `limit+1` 起补足，保持每国样本 = 15 | 样本变成 13 条 → "本期前 15 条"是假的，且 `< MIN_ITEMS_VALID` 会让整国失效 |

#### 7.6.2 管线顺序

```
抓取（每国 limit + CANDIDATE_POOL_EXTRA = 25 条候选）
  → 解析 / 去重
  → 逐条打筛查标记（screen.mjs，纯文本规则）
  → 分簇（在 25 条候选上聚类，簇可能跨国）
  → 簇级裁决：hard 命中 → 整簇移除；决策文件标记 exclude → 整簇移除
  → 每国按原 rank 取前 15 条，跳过被移除簇
  → 计算共识 / 未包含 / 偏移 / 时间标记
  → 翻译 ≤61 条
  → 渲染
```

为什么先取 25 条而不是 15 条：簇级剔除必须能回补，而回补只能在聚类前留出余量。候选池 25×15 = 375 条向量，比 225 条多 67%，CPU 上约多 1–2 秒，可接受。

**边界**：回补后某国 < `MIN_ITEMS_FULL`（12）→ 该国卡片标"样本 n 条"，不参与未包含与偏移；< `MIN_ITEMS_VALID`（10）→ 整国半失效。这条沿用 §13 的降级矩阵，不为筛查开例外。

#### 7.6.3 两种模式

| `SCREEN_MODE` | 行为 | 适用 |
|---|---|---|
| **`review`（默认）** | 出现任一 soft 命中就**不自动发布**，输出预检表等人确认；确认后重跑发布 | 上线前两周、规则未调准时 |
| `auto` | soft 命中照常发布，仅记录；hard 命中始终自动剔除 | 规则稳定后 |

`hard` 规则在任何模式下都**自动剔除、不进人工流程**，所以必须少而准——误杀会直接改变共识数字。

**超时行为**：`review` 模式下没人确认，就保持上一份快照（页面显示"上次更新"），连续错过 2 个 slot 触发告警（§10.4）。不做"等太久就强行发布"的兜底。

#### 7.6.4 规则与决定文件

| 文件 | 提交 | 内容 |
|---|---|---|
| `src/config/sensitive.json` | ✅ | **通用内容安全模板**，只有机制与 3 条示例；默认 0 条 hard |
| `src/config/sensitive.local.json` | ❌ gitignore | 地域性/时效性规则，结构相同，运行时合并 |
| `src/config/screen-decisions.json` | ✅ | 人工判定：`{ decisions: [{ id, action: "exclude"\|"keep", reason, decidedAt }] }`，`id` 是标题 sha256 前 16 位 |

规则**引擎**在仓库里，规则**词条**归运营者。这样仓库不会因为保存一份清单本身成为风险点，也不会把内容判断的责任写进代码。

#### 7.6.5 对"未包含"的影响（这是最关键的一节）

"本期前 N 条未包含"的含义是"在这个样本里没出现"。筛查改变的是**样本的选取方式**，不改变这句话的真值——前提是簇级剔除。举例：

- 事件 X 在 12 国出现，其中 3 国靠回补进入样本 → 仍是 12 国在报，结论正确。
- 事件 X 被判为剔除 → 全 15 国一起移除 → 页面不显示这个事件，也不会说"谁没报它"。
- ❌ 若只剔德国那一条 → 页面会说"12 国在报，德国没报"，而德国报了。**这就是必须禁止条级剔除的原因。**

#### 7.6.6 披露口径

页面**不展示**被剔除的内容（否则等于换个地方又搬上来了），但必须披露"存在筛查"这一事实，否则产品的基本诚实性打折：

- `/about`：「样本经过内容筛查，被剔除的条目不计入任何标记；剔除数量在状态页公开。」
- `/status`：`screenedOut` 数量、命中规则数、当前 `SCREEN_MODE`。
- `status.json` 增加 `screening: { mode, softHits, hardHits, excludedClusters, excludedItems }`。

#### 7.6.7 局限（必须写在文档里，不要假装解决）

- **规则只能减少、不能消除风险**：跨语言、隐喻、人名、地名变体都会漏；漏检的责任在运营者，不在引擎。
- **它是内容级控制，不是站点级合规**：备案审查看的是站点性质（境外新闻聚合），不因为你筛掉几条就通过。筛查解决的是传播侧与单条风险，§15 的备案问题依然独立存在。
- **会引入运营依赖**：`review` 模式下每 12 小时需要一次人工确认，这是真实的时间成本，不要低估。
- **误杀比漏检更难发现**：漏检你会看到，误杀不会——所以 `hard` 规则要少，且每次新增都要在预检表上验证。

#### 7.6.8 工具

| 命令 | 作用 |
|---|---|
| `node src/scripts/screen-preview.mjs --check` | 校验规则文件结构，列出会自动剔除的 hard 规则 |
| `node src/scripts/screen-preview.mjs` | 对最近一次抓取做预检，输出带 id 与勾选栏的表格到 `data/review/` |
| `node tests/unit/screen.test.mjs` | 引擎单测（CJK 子串、词边界、白名单、簇级、坏正则容错） |

成本：0.5 人日（引擎 + 预检 + 单测已交付）；日常运营约 5 分钟/次（只看被挑出来的条目）。

---

## 8. 事件聚类（核心）

### 8.1 向量化（`embed.mjs`）

| 项 | 取值 |
|---|---|
| 模型 | `Xenova/multilingual-e5-small`（量化） |
| 运行时 | `@huggingface/transformers` v3（原 `@xenova/transformers` v2 已更名，锁新版） |
| 输入 | `query: ${cleanTitle}`（e5 系列要求 `query:`/`passage:` 前缀；这里是对称比较，全部用 `query:`），单条上限 128 token |
| 池化 | mean pooling + L2 归一化 |
| 批大小 | 32 |
| 缓存 | 标题 SHA-256 → 向量；`data/cache/embeddings.json`，按 LRU 保留最近 5000 条 |
| 版本 | 模型 revision 写入快照，换模型必须升 `algorithmVersion` |

**模型缓存的路径要说清（v1.0 写错）**：`transformers.js` 在 Node 下的默认缓存目录是**当前工作目录下的 `./.cache`**（由 `env.cacheDir` 控制），不是 Hugging Face Python 生态的 `~/.cache/huggingface`。按 v1.0 去缓存 `~/.cache/huggingface` 会每次都重新下载约 120 MB 模型，CI 必然超时或反复触发限流。

正确做法：

```js
import { env, pipeline } from '@huggingface/transformers';
env.cacheDir = process.env.MODEL_CACHE_DIR ?? './.cache';
env.allowLocalModels = false;   // 只走远端 + 上面指定的缓存
```

- workflow 的 `actions/cache` 路径设为 `${{ github.workspace }}/.cache`，key 含模型名与版本。
- 缓存未命中时首次下载约 120 MB / 20–60 秒；命中后加载 < 5 秒。
- 缓存 key 必须含 `package-lock.json` 哈希，否则升级运行时后仍复用旧 ONNX 文件可能报错。
- 在 CI 里加一条断言：`run.mjs` 启动时打印 `env.cacheDir` 与该目录内是否已有模型文件，避免"看起来缓存了其实没命中"。

### 8.2 实体与数字信号

**实体**（`src/config/entities.json`）：

```json
{
  "entities": [
    {
      "id": "Q123",
      "canonical": "European Union",
      "aliases": {
        "en": ["EU", "European Union"],
        "de": ["EU", "Europäische Union"],
        "fr": ["UE", "Union européenne"],
        "ja": ["EU", "欧州連合"],
        "ko": ["EU", "유럽연합"],
        "es": ["UE", "Unión Europea"],
        "pt": ["UE", "União Europeia"],
        "it": ["UE", "Unione Europea"],
        "id": ["UE", "Uni Eropa"],
        "hi": ["यूरोपीय संघ"]
      }
    }
  ]
}
```

- 维护约 500 个高频实体（国家、主要人物、组织、地名）。
- 匹配：对标题做别名子串匹配（大小写不敏感，CJK 直接匹配）；命中后映射到 `id`。
- 大小写敏感语言（德文名词）不受影响；英文全大写缩写要求词边界。

**数字**：提取 `\d{1,4}`（年份、人数、票数、日期）与序数词，归一化为集合。`2026` 这类年份权重减半，避免"同一年的新闻"被误连。

### 8.3 相似度

对跨国家的条目对：

```js
cos         = cosine(emb_a, emb_b)          // 0..1，向量已 L2 归一化
entityScore = |A∩B| / min(|A|, |B|)         // 仅双方都有实体时有意义
numberScore = |A∩B| / max(|A|, |B|)         // 仅双方都有数字时有意义

weights = { cos: 0.78 }
if (双方都有实体) weights.entity = 0.14
if (双方都有数字) weights.number = 0.08
sim = Σ wᵢ·sᵢ / Σ wᵢ                        // 按可用信号归一化
```

**为什么不像 v1.0 那样给缺失信号填 0.5 中性值**：加成式 + 中性值会让"有没有实体"直接改变可匹配的余弦上限。代入 v1.0 的 0.70/0.20/0.10 与阈值 0.80：

| 情形 | 达到 sim=0.80 所需余弦 |
|---|---|
| 双方都有实体、都有数字且全重合（entity=number=1） | cos ≥ 0.714 |
| 双方都有实体但**是不同实体**（entityScore=0） | cos ≥ 1.000 → **永不可能匹配** |
| 双方都无实体无数字（取中性 0.5/0.5） | cos ≥ 0.929 → **几乎不可能匹配** |

同样的余弦，在三种情形下结论完全相反。后果是"有实体但不重合"的条目对被硬性互斥，体育、天气、文化这类无实体标题几乎无法匹配——而这恰恰是最可能出现全球共识的一类新闻。

**修正**：改为条件权重归一化，`sim` 恒为可用信号的加权平均，语义稳定；实体约束不再混在分数里，而是用显式门槛表达：

```
gate(a, b) =
     cos >= 0.86          // 高余弦可直接匹配
  || entityScore >= 0.5   // 或共享半数以上实体
  || numberScore >= 0.5   // 或共享关键数字

match(a, b) = gate(a, b) && sim(a, b) >= T_MATCH
```

- `T_MATCH` 初值 0.80，由 §16.2 校准，目标 P ≥ 0.90 不变。
- 门槛常量 `0.86 / 0.5 / 0.5` 与 `T_MATCH` 一并放进 `constants.mjs`，同样参与校准。
- 缺实体/缺数字不再被惩罚，只降低该信号的话语权。
- `sim ∈ [0, 1]`，且同一对标题不会因信号组合不同而语义反转。

### 8.4 聚类流程

```
1. 仅取 stats.countriesValid 中的条目
2. 生成 国家对 × 条目对 的候选（约 2.5 万对）
3. 预筛：余弦 < 0.55 且 entityScore < 0.5 直接跳过（省算力，同时不误杀"实体相同但措辞不同"的配对）
4. 计算 gate 与完整 sim
5. match(a, b) 为真（§8.3）→ union(a, b)
6. 生成簇；同国多条只保留与簇质心最相似的一条参与计数
7. 计算簇凝聚力 cohesion = 成员两两 sim 均值
8. 单条簇视为独立事件
```

**硬约束**：

- 合并必须通过 §8.3 的 `gate()`：不得仅因主题相同而合并。
- 簇内国家数 ≥ 2 才参与共识展示；否则 `consensusCount = 1`。
- `cohesion < 0.72` 的簇不输出"未包含"标记（仍可显示共识计数，但标记为低置信）。
- 同一国家在一个簇中最多计 1 次。

**阈值**：`T_MATCH` 初始 0.80，必须用 `tests/fixtures/labeled-pairs.jsonl` 校准；校准后写入 `algorithmVersion` 对应的常量表，不散落在代码里。

### 8.5 代表性标题

- 簇质心 = 成员向量均值归一化。
- `medoid` = 与质心余弦最高的成员；其 `titleOriginal` 作为事件标签。
- 该条的 `publisher` 用于归属展示，但不代表"事件来源"。
- `labelZh` 取 medoid 的译文；无译文则为 `null`，前端回退原文。

### 8.6 失败与降级

| 情况 | 行为 |
|---|---|
| 模型加载失败 | 降级到"同语种圈关键词聚类"（`clusterFallback.mjs`），快照标 `degraded` |
| 内存不足 | 减小批大小到 8；仍失败则同上 |
| 条目数 < 60 | 不做跨语言聚类，只做国内去重；所有共识/未包含标记关闭 |
| 校准集缺失 | CI 警告，不阻塞；生产环境仍使用已发布的常量阈值 |

---

## 9. 主题分类与议程偏移

### 9.1 主题表（`src/config/topics.json`）

| key | 中文名 | 英文锚点示例 |
|---|---|---|
| conflict | 冲突与安全 | war, ceasefire, missile strike, military operation, hostage |
| politics | 政治与治理 | election, parliament, president, coalition, impeachment |
| economy | 经济与市场 | inflation, interest rate, stocks, tariff, unemployment |
| tech | 科技与 AI | artificial intelligence, chip, cyberattack, startup, satellite |
| climate | 气候与能源 | wildfire, flood, heatwave, emissions, oil price |
| society | 社会与民生 | protest, housing, education, strike, demographic |
| health | 健康与医疗 | outbreak, vaccine, hospital, disease, drug approval |
| migration | 移民与边境 | border, refugee, asylum, deportation, visa |
| justice | 司法与犯罪 | court, verdict, investigation, arrest, corruption |
| sports | 体育与文化 | football, olympics, film festival, concert, award |
| other | 其他 | — |

每个主题 6–10 条英文锚点，共约 80 条。锚点只用于生成向量，不在界面出现。

### 9.2 分类

```
anchorVec[t][i] = embed("query: " + anchor)
itemTopicDist = softmax( cos(emb_item, anchorVec) / T_TOPIC )   // T_TOPIC = 0.05
              → 按主题求和、归一化
countryTopicDist = mean(itemTopicDist) 经 Dirichlet(α=0.5) 平滑后归一化
```

- 软分类避免"一条标题只能属于一个主题"的硬伤。
- `topic` = argmax，`topicConfidence` = 该主题概率。
- 样本不足（`itemsValid < MIN_ITEMS_TOPIC`，见 §5.8）时 `agendaOffset = null`。

### 9.3 偏移度量

```
pbar_loo = mean(countryTopicDist for all valid countries except c)
jsd = JSD(p_c, pbar_loo)        // 以 2 为底，值域 [0, 1]
```

- 采用留一法，避免该国自己拉高均值导致偏移被低估。
- 不用欧氏距离：JSD 对分布更合适且有界。

### 9.4 分档与文案

- 历史分位：取最近 14 份快照中该国的 JSD 序列，计算 P50、P80。
- 阈值：`t1 = max(0.05, P50)`，`t2 = max(0.12, P80)`。
- 分档：`jsd < t1` → `close`（接近）；`< t2` → `slight`（略偏）；否则 `clear`（明显偏）。
- 历史不足 6 份时使用固定 `0.05 / 0.12` 并标 `provisional=true`。
- `note` 生成：
  - `delta = p_c - pbar_loo`；
  - 取 `delta ≥ +0.05` 的最大主题作为"更关注 X"；
  - 取 `delta ≤ -0.05` 的最小主题作为"较少关注 Y"；
  - 两者都存在 → `更关注{X}，较少关注{Y}`；只有一个 → 单句；都没有 → `note=null`。
- 界面只显示档位与这句话，不显示 0.72 这类小数。

### 9.5 边界

- `other` 占比 > 0.4 时，`note` 置 `null`（避免用"其他"造句）。
- 同一国家连续两次 `clear` 不额外强调；V2 再做趋势。
- 偏移是描述性指标，关于页必须写明"不代表立场或质量"。

---

## 10. 共识、未包含与时间标记

### 10.1 共识

```
denominator = stats.countriesValid
for each cluster:
  countries = distinct valid country codes of members
  consensusCount = |countries|
  consensusRatio = consensusCount / denominator
```

展示规则（前端）：

| 条件 | 展示 |
|---|---|
| `consensusCount == 1` | `×1` + 暖色小点，`aria-label="仅 1 国样本报道"` |
| `ratio ≥ 0.67` | `×n` 灰色，`aria-label="有效样本 {denominator} 国中 {n} 国报道"` |
| 其他 | `×n` 常规色 |

分母不是 15 时，tooltip 必须写实际分母；禁止写死"15 国"。

### 10.2 本期未包含

```
if denominator < DENOM_MIN: 关闭
tau = max(TAU_MIN, ceil(TAU_RATIO * denominator))
for each valid country c with itemsValid >= MIN_ITEMS_FULL:
  candidates = clusters.filter(cl =>
      cl.countryCount >= tau &&
      !cl.countries.has(c.code) &&
      cl.cohesion >= COHESION_MIN)
  pick candidates sorted by (countryCount desc, cohesion desc, recency desc)[0]
```

- `silentEvent.confidence` 直接取 `cl.cohesion`，不再单列第二个阈值（v1.0 同时出现 `cohesion >= 0.72` 与 `confidence >= 0.8`，但 `confidence` 从未被定义）。

- 每国最多 1 条，界面一行。
- 只在该国 `status.ok && !stale && itemsValid >= MIN_ITEMS_FULL` 时输出；`stale` 或条目不足一律 `null`。
- 文案：`本期前 {itemsValid} 条未包含：{labelZh ?? label}（{n} 国样本在报）`。**N 用该国实际条数**，不写死 15。
- 事件标签超长截断 40 个字符；完整文本放 `title` 属性。
- `reportingCodes` 存入数据，供 V2 "展开哪些国在报"，V1 不展示。

**为什么 v1.1 把硬门槛从 15 下调到 12**：v1.0 要求 `itemsValid >= 15` 才能输出未包含。但 Google News 各国版本的条目数并不固定，小语种地区（印尼、南非、韩国）长期可能只返回 10–14 条。一旦如此，条件永不成立，"未包含"这一行在多数卡片上**永久为空**——产品最核心的差异点直接消失，而日志里不会有任何错误。改为"要求 ≥ 12 条 + 文案用实际条数"，既保住事实准确性（说清是"前 N 条"），又不让功能被工程门槛悄悄吃掉。

**报告口径仍要更严**：`itemsValid < limit` 的国家，其未包含标记额外带 `partialSample: true`，前端在行尾加一个淡色 `· 样本 {n} 条`，让读者知道这不是完整样本。

**为什么最低是 12 而不是更低**：样本小于 12 时，任一事件缺席的概率都很高（组合爆炸），"未包含"退化为噪声；此时宁可整行不输出。

### 10.3 连续天数

- 历史簇存 **3 条代表标题**（`lastTitles`，按贴近质心降序），不存向量本身——向量随模型版本失效，重算是毫秒级。
- 匹配分 `matchSim` =「当前簇成员 × 历史代表标题」的最大 `sim`（§8.3），满足全部条件才继承 `eventId`：
  - `matchSim >= LINEAGE_SIM`（0.85）；
  - 国家集合 Jaccard ≥ `LINEAGE_JACCARD`（0.5）；
  - 双方都有实体时，实体集合必须有交集。
- 贪心一对一，按 `matchSim` 降序；未匹配的簇分配新 `eventId`（ULID）。
- `seenDates` 按 `Asia/Shanghai` 自然日去重：同一天的两份快照只计 1 天。
- `consecutiveDays`：从最近 slot 向前数连续自然日，中断即停。
- 展示：`consecutiveDays >= CONSECUTIVE_TAG`（3）时标题旁显示 `连续N天`。
- 仅统计进入该国前 `limit` 条的出现，不统计展示的 3 条。

**为什么不用"单个 medoid 标题"做继承（v1.0 的做法）**：同一事件跨天时代表标题会漂移——第 1 天是"反对党获胜"，第 2 天是"新总理宣誓就职"，第 3 天是"内阁名单公布"。用单一 medoid 相似度匹配，第 2 天就会断裂，"连续 3 天"这条标记几乎永远不会触发。改用 3 条代表 + 国家集合 + 实体三重条件后，事件主线保持连续，同时仍能被国家集合变化挡住"不同事件误接"。

### 10.4 突变

```
prev = 当前 slot 之前最近的一份快照
if !prev || !prev.stats || prev 有效国家 < DENOM_MIN || 当前有效国家 < DENOM_MIN: suddenShift = null
A = 当前该国簇的 eventId 集合（前 limit 条）
B = prev 该国簇的 eventId 集合
setDistance = 1 - |A ∩ B| / |A ∪ B|
topicDistance = JSD(当前国家主题分布, prev 国家主题分布)
isShift = setDistance >= 0.70 && topicDistance >= 0.12
```

- 双条件避免单日噪声。
- 显示文案："较上次突变"；tooltip 给出两个数值（保留两位）。
- 连续两次触发时仍显示，但状态页记录频率；若某国一周内触发 ≥ 5 次，说明阈值偏低，需复核。

### 10.5 计算顺序依赖

```
fetch → dedupe → truncate(limit) → embed → cluster → lineage(继承 eventId)
     → consensus → silence（依赖 cluster + status）
     → topConsensus（依赖 cluster + cohesion）
     → topics → agendaOffset（依赖 history）
     → suddenShift（依赖 lineage + topics）
     → translate（依赖 displayItems + topConsensus + silentEvent，只翻这些）
```

任何一步失败：该步骤产出的字段置 `null`，页面隐藏对应标记，不阻塞其他字段；快照 `degraded=true` 并写入原因。

---

## 11. 页面设计

### 11.1 路由

| 路径 | 文件 | 内容 |
|---|---|---|
| `/` | `dist/index.html` | 状态条 + 共识条 + 15 张卡片 + 地区筛选 |
| `/status` | `dist/status.html` | 源健康表 |
| `/about` | `dist/about.html` | 产品说明、方法、版权、免责声明、联系方式 |
| `/404` | `dist/404.html` | 静态 404 |

Cloudflare Pages 不需要服务端路由；生成 `status.html`，并在 `_redirects` 写 `/status /status.html 200`、`/about /about.html 200`。

### 11.2 首页结构

```html
<a class="skip" href="#main">跳到内容</a>
<header class="masthead">
  <h1>世界头条切片</h1>
  <nav aria-label="站点">
    <a href="/" aria-current="page">头条</a>
    <a href="/status">状态</a>
    <a href="/about">关于</a>
  </nav>
</header>

<div class="statusline">
  <span class="dot dot-green" aria-hidden="true"></span>
  <p class="status-health" role="status">数据抓取于 <time datetime="2026-10-28T14:03:21+08:00">14:03</time>，14/15 国有效</p>
  <span class="sep" aria-hidden="true">·</span>
  <p class="status-next">下次更新 <time datetime="2026-10-29T00:00:00+08:00">00:00</time>
    <span id="countdown" data-next="2026-10-28T16:00:00.000Z" aria-live="off">（还有 9 小时 57 分）</span></p>
</div>

<section class="top-consensus" aria-label="本期共识">
  <p class="tc-line">
    <span class="tc-label">本期共识</span>
    <span class="tc-event">全国选举重新计票</span>
    <span class="tc-count">13/14 国样本在报</span>
  </p>
</section>

<nav class="regions" aria-label="按地区筛选">
  <button data-region="all" aria-pressed="true">全部</button>
  <button data-region="americas" aria-pressed="false">美洲</button>
  <button data-region="europe" aria-pressed="false">欧洲</button>
  <button data-region="asia" aria-pressed="false">亚洲</button>
  <button data-region="oceania" aria-pressed="false">大洋洲</button>
  <button data-region="africa" aria-pressed="false">非洲</button>
</nav>

<main id="main" class="grid">
  <article class="card" data-region="europe" data-country="DE">...</article>
  <!-- 15 张 -->
</main>

<footer>
  <p>标题来自 Google News Top Stories 的公开 RSS；本站只做样本展示与算法标注。</p>
  <p>标注为辅助信息，可能存在误差。<a href="/about">方法与免责声明</a></p>
</footer>
<script src="/assets/app.js" defer></script>
```

### 11.3 卡片结构

```html
<article class="card" data-region="europe" data-country="DE" aria-labelledby="h-DE">
  <header class="card-head">
    <svg class="flag" role="img" aria-label="德国国旗"><use href="/assets/flags.svg#flag-de"/></svg>
    <h2 id="h-DE">德国 <span class="code">DE</span></h2>
    <span class="badge badge-shift" title="较上次：事件集合差异 0.74，主题差异 0.16">较上次突变</span>
  </header>

  <ol class="items">
    <li class="item">
      <a href="https://www.spiegel.de/..." target="_blank" rel="noopener noreferrer nofollow">
        <span class="rank" aria-hidden="true">01</span>
        <span class="title" lang="zh-CN">反对党以微弱优势获胜</span>
        <span class="orig" lang="de">Opposition gewinnt knapp</span>
        <span class="count count-consensus" title="有效样本 14 国中 12 国报道"
              aria-label="14 国样本中 12 国报道">×12</span>
        <span class="tag">连续3天</span>
      </a>
      <span class="meta">Spiegel · spiegel.de · 12:12</span>
    </li>
    <!-- 3 条 -->
  </ol>

  <p class="silent" title="全国选举重新计票——本期前 15 条未包含，12 国样本在报">
    本期前 15 条未包含：全国选举重新计票（12 国样本在报）
  </p>

  <div class="offset" role="img"
       aria-label="议程偏移：明显偏离（更关注经济，较少关注冲突）">
    <div class="offset-bar" style="--intensity: 0.93"></div>
    <span class="offset-sr">更关注经济，较少关注冲突</span>
  </div>
</article>
```

规则：

- 整条标题是唯一链接；不在卡片内放第二个可点击区域。
- **链接一律是解码后的发布方真实域名**（D25）。`linkDecoded=false` 或协议不合法时，该条渲染为不可点的 `<div class="item-static">`，样式与可点条目一致但无下划线、无 `cursor:pointer`；`meta` 行照常显示来源与时间。
- **禁止渲染任何指向 `news.google.com` 的 `href`**。`preflight` 会扫描产物，命中即构建失败——这是硬约束，不是建议。
- `meta` 行固定显示「来源名 · 域名 · 本地时间」。面向大陆用户，这一行是"这条值不值得自己去搜"的唯一判断依据，不能省。
- 未包含行的"N"必须来自该国实际 `itemsValid`；`partialSample` 为真时行尾追加淡色 `· 样本 {n} 条`，让读者知道这不是完整样本。
- 原文行在译文存在时显示；无译文时只显示原文，且 `lang` 用该条语言。
- `count` 的颜色不是唯一信息载体：有 `aria-label` 与文本 `×n`。
- 偏移条高度 2px，颜色由 `--intensity` 映射；同时提供屏幕阅读器文本。
- `title` 属性仅作补充，不作为唯一信息来源。

### 11.4 视觉规范

**色彩（浅色）**

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#FBFAF7` | 页面背景（暖白纸感） |
| `--surface` | `#FFFFFF` | 卡片 |
| `--ink` | `#17181A` | 主文字 |
| `--muted` | `#6B6F76` | 次要文字 |
| `--hairline` | `#E6E3DC` | 分隔线/边框 |
| `--consensus` | `#8A8F98` | 共识计数灰 |
| `--unique` | `#C2410C` | 独家暖色点 |
| `--shift` | `#B45309` | 突变徽标 |
| `--warn` | `#B45309` | 数据陈旧 |
| `--danger` | `#B91C1C` | 抓取失败 |
| `--ok` | `#15803D` | 健康绿点 |

**色彩（深色，`prefers-color-scheme: dark`）**

| Token | 值 |
|---|---|
| `--bg` | `#141412` |
| `--surface` | `#1C1C19` |
| `--ink` | `#EDEBE5` |
| `--muted` | `#A3A099` |
| `--hairline` | `#302F2B` |
| `--consensus` | `#8E8A82` |
| `--unique` | `#F97316` |

所有正文对比度 ≥ 4.5:1；`--muted` 在小字号下也需 ≥ 4.5:1（实现后用 axe 校验）。

**字体**

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI",
             "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei",
             system-ui, sans-serif;
--font-num: ui-monospace, "SF Mono", Consolas, monospace;
```

- 不加载 Web Font（性能与隐私）。
- 数字使用 `font-variant-numeric: tabular-nums`。

**字号/间距**

| 用途 | 值 |
|---|---|
| 页面标题 | 22px / 1.2 / 600 |
| 国家名 | 16px / 1.3 / 600 |
| 新闻标题 | 14px / 1.45 / 400 |
| 原文行 | 11px / 1.3 / 400 |
| 标记/元信息 | 11px / 1.2 |
| 卡片内边距 | 16px |
| 网格间距 | 16px |
| 最大宽度 | 1200px |

**卡片**

- 1px `--hairline` 边框，圆角 8px，无阴影。
- 卡片等高：`min-height: 210px`；标题最多 2 行（`-webkit-line-clamp: 2`），不撑破布局。
- 悬停仅改变标题下划线颜色，不做位移动画；`prefers-reduced-motion` 下禁用过渡。

**共识条（`topConsensus`）**

- 满宽单行，上下 12px 留白，**无边框、无底色**：它是指针，不是卡片，视觉权重必须低于卡片标题。
- `tc-label` 用 `--muted`（11px/500），`tc-event` 用 `--ink`（14px/600），`tc-count` 用 `--consensus`（11px，`tabular-nums`）。
- 分母用实际有效国家数（`13/14`），不用固定 15。
- **不设链接**（D18）：事件有多国来源，选哪条原文等于编辑判断。
- `topConsensus` 为 `null` 时不渲染整个 `<section>`，不留空行、不留占位。
- 移动端 `tc-count` 折到第二行，`tc-event` 最多 1 行截断（`title` 属性存全文）。

**偏移条**

```css
.offset-bar {
  height: 2px;
  background: linear-gradient(90deg,
    #D6D3CC 0%,
    #C2410C calc(var(--intensity) * 100%),
    #E6E3DC calc(var(--intensity) * 100%));
  opacity: calc(0.35 + var(--intensity) * 0.65);
}
```

- 数值只用于视觉强度；文字档位在 `aria-label` 中。
- 不用红绿表示好坏，避免价值判断。

### 11.5 响应式

| 断点 | 列数 | 说明 |
|---|---|---|
| ≥ 1200px | 3 | 桌面 |
| 768–1199px | 2 | 平板/小笔记本 |
| < 768px | 1 | 手机；一屏约 2 张卡片 |

- 地区筛选在移动端横向滚动，不换行。
- 状态条在窄屏分两行，倒计时可省略"还有"。

### 11.6 交互与降级

| 功能 | JS 行为 | 无 JS |
|---|---|---|
| 地区筛选 | 切换 `hidden`，更新 `aria-pressed` | 全部显示，按钮为普通按钮但不工作（用 `<noscript>` 提示"筛选需启用 JS"） |
| 倒计时 | 每 30s 更新 | 显示静态"下次更新 00:00" |
| 译文切换 | 默认 `data-lang-mode="translated"`；点击切到 `original` 并写 localStorage | 同时显示译文与原文（CSS 默认两者可见，切换只改变主次顺序） |
| 点击标题 | 新标签打开原文 | 同 |

`app.js` 预算 < 4 KB（未压缩），无依赖，无 `innerHTML`。

### 11.7 性能预算

| 指标 | 目标 |
|---|---|
| HTML（gzip） | < 90 KB |
| CSS（gzip） | < 8 KB |
| JS（gzip） | < 2 KB |
| 首屏请求数 | ≤ 4（HTML、CSS、JS、flags） |
| LCP（4G 模拟） | < 1.5s |
| CLS | < 0.02 |
| 无第三方请求 | 是 |

实现要点：预渲染、无字体、无图片、SVG sprite 内联或单文件、`content-visibility: auto` 用于折叠区。

### 11.8 可访问性

- 语义：`header/nav/main/article/ol/li/footer`。
- 每个链接可键盘聚焦，`:focus-visible` 2px 外框。
- 标记有文本或 `aria-label`，不只靠颜色。
- 翻译行有 `lang` 属性，屏幕阅读器切换发音。
- 状态点有文字说明（"数据正常/部分源异常"）。
- 跳转链接、`aria-current`、`aria-pressed` 完整。
- 目标：axe 无 critical/serious；对比度全部通过。

### 11.9 页面元信息（v1.0 遗漏）

产品靠"截图 + 链接回流"传播，链接预览是唯一的第二入口，但 v1.0 没写任何 `<head>` 要求。每个页面必须包含：

| 项 | 值 |
|---|---|
| `lang` | `<html lang="zh-CN">` |
| `<title>` | 首页 `世界头条切片 · 15 国头条样本 <MM-DD HH:mm>`；状态页/关于页带后缀 |
| `meta description` | 一句话说明 + 生成时间 + 有效国家数 |
| `og:title` / `og:description` | 与 title/description 同源，字数控制在 60 / 120 内 |
| `og:type` | `website` |
| `theme-color` | 浅色 `#FBFAF7`，深色用 `media` 属性给 `#141412` |
| favicon | 内联 SVG data URI（单色方块 + 斜杠），不额外发请求 |
| `canonical` | 自定义域名下的对应路径 |
| 时间语义 | 首页 `<title>` 里的时间用 `Asia/Shanghai`，与状态条一致 |

- **不做** `og:image`：V1 不生成分享图（§22 已列为 V2），宁可不给预览也不要引用一张不存在的图。
- 不做 `sitemap.xml`（V1 只有 3 个页面）；`robots.txt` 允许抓取，禁止抓 `data/`。
- `<noscript>` 放在 `main` 之前，一句话："筛选与倒计时需要 JavaScript；内容本身无需 JS 即可阅读。"

---

## 12. 状态页与关于页

### 12.1 `/status`

静态表格，由 `status.json` 渲染：

| 列 | 内容 |
|---|---|
| 国家 | 国旗 + 名称 + code |
| 版本 | `hl/gl` 或 fallback 标记 |
| 状态 | 绿/黄/红点 + 文本 |
| 最近成功 | 本地时间（Asia/Shanghai） |
| HTTP | 状态码 |
| 条数 | 实际抓取条数 |
| 耗时 | ms |
| 连续失败 | 次数 |
| 备注 | 错误摘要 |

另需一块"资源用量"：本月翻译字符数 / 50 万上限、模型缓存是否命中、本月 Actions 运行次数。

顶部：总体状态、最后更新时间、下次运行时间、有效国家数。
底部：说明"绿点只代表本次抓取成功，不代表内容质量"；若有国家替换，列出 `status.json` 的 `changes` 记录。

### 12.2 `/about`

必须包含：

1. 一句话产品说明与"它不是新闻阅读器"。
2. 数据来源：Google News Top Stories 公开 RSS；每国一个聚合源；fallback 说明。
3. 方法：共识、未包含、偏移、时间标记的定义与阈值口径。
4. 明确的局限：
   - 样本是算法排序结果，不是报纸头版；
   - "未包含"不等于未报道；
   - 标注可能有误，不构成事实断言；
   - 单一源不能代表一国媒体生态。
5. 版权：只展示标题、标题机翻与链接，不展示摘要、图片、全文；版权归原发布方；删除请求邮箱。
6. 翻译声明：**默认展示机器翻译**（提供商：DeepL / Cloudflare Workers AI），可能出错，原文以链接为准；可一键切原文。
7. **受众与可达性声明（D11/D26）**：本站面向中国大陆读者。页面上的一切内容——译文标题、四个标记、来源名、域名、时间——**无需任何境外网络即可完整阅读**；但部分来源网站本身需要可访问境外网络才能打开。本站不提供、也不引导任何绕过手段。对所标注结论的核对，只看页面内容即可完成。
8. **跳转说明（D25）**：每条标题的链接指向发布方真实域名，不经过任何中转；若某条链接无法还原为真实域名，该条不显示为可点链接，只保留标题与来源。
9. **口径声明（D21）**："本期前 N 条未包含"仅指本站在该国的 Google News Top Stories 样本中没有出现，不代表该国媒体未报道，也不代表任何编辑立场。
10. 更新节奏与故障处理；国家替换记录（用过备用池时列出换下/换上的国家与时间）。
11. 联系邮箱、更新日志。

文案语气：描述，不指控；不使用"审查""封锁""压制"等推断词。

---

## 13. 错误处理与降级矩阵

| 故障 | 检测 | 页面行为 | 数据标记 | 告警 |
|---|---|---|---|---|
| 单国主源失败 | HTTP/超时/解析 | 用 fallback；无则用陈旧快照；再无则占位 | `usedFallback` / `stale` / `ok=false` | 连续 3 次失败 |
| ≥3 国失败 | stats | 顶部黄/红条 + 有效国家数 | `degraded=true` | 是 |
| 条目 `< MIN_ITEMS_FULL`（12） | itemsValid | 卡片显示"样本 n 条" | 不参与未包含、不参与偏移 | 连续 2 次 |
| 条目 `< MIN_ITEMS_VALID`（10） | itemsValid | 该国卡片半失效 | 不参与共识分母与全部标记 | 是 |
| 有效国家数 `< DENOM_MIN`（10） | stats | 顶部红条 + 关闭跨语言标记 | `degraded=true` | 是 |
| 模型不可用 | 异常 | 关闭跨语言标记，显示提示 | `degradedReasons += model_unavailable` | 是 |
| 翻译配额耗尽（本月 >40 万字符） | 计数器 | 全部回退原文，标题栏不加译文行 | `degradedReasons += translation_unavailable` | 提示 |
| 翻译服务不可用 | 异常 | 同上；不阻塞发布 | 同上 | 连续 3 次则告警 |
| 链接解码率 < 80% | 统计 | 无 | `linkDecoded` 统计入 status | 提示 |
| 无历史快照 | 文件缺失 | 隐藏连续/突变 | 字段 `null` | 否 |
| 只有 1 份历史 | 文件数 | 偏移用固定阈值 | `provisional=true` | 否 |
| Schema 校验失败 | Ajv | **不发布**，保留上一版 | 退出码 1 | 是 |
| 渲染异常 | 异常 | 不提交 dist；数据仍可保留 | 退出码 1 | 是 |
| 提交冲突 | git push 失败 | 重试 rebase 2 次 | — | 是 |

**总原则**：宁可少标，不可错标；数据可以降级，页面不能白屏。

---

## 14. 可观测性

- **Actions 日志**：每国一行（code、http、条数、耗时、fallback、错误），最后输出汇总表。
- **Job Summary**：用 `$GITHUB_STEP_SUMMARY` 写 Markdown 表格，便于事后查看。
- **status.json**：持久化健康状态，供 `/status` 展示。
- **告警**：workflow 失败或 `overall=red` 时依赖 GitHub 通知；可选加一个 webhook（不引入第三方 SDK）。
- **审计**：快照文件即历史；每次提交包含 `algorithmVersion` 与模型 revision。
- **不做**：客户端埋点、第三方分析、Cookie。

---

## 15. 安全与合规

| 风险 | 措施 |
|---|---|
| XSS（标题含脚本） | 渲染层统一 `escapeHtml`；禁止 `innerHTML`；E2E 用恶意 fixture 验证 |
| 恶意链接（`javascript:`） | 链接协议白名单 `http/https`；不符合则渲染为纯文本 |
| XML 实体攻击 | XML 解析关闭实体展开，限制 2 MB |
| SSRF | 只抓配置文件中的固定 URL，不接受用户输入 |
| CSP | `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'` |
| 点击劫持 | `frame-ancestors 'none'` |
| 依赖投毒 | 锁文件 + `npm ci`；仅使用必要依赖 |
| 密钥泄露 | 翻译密钥（`DEEPL_API_KEY`、`CF_API_TOKEN`）仅存 GitHub Secrets，构建产物与前端不接触；其余无密钥 |
| 版权 | 只存标题、标题机翻与链接；不存摘要/图片/全文；提供删除邮箱；遵守 `robots.txt` |
| 政治表述 | 统一口径；关于页声明"呈现差异，不代表立场"；避免推断性词汇 |
| 大陆可达性 | 自定义域名 + 可选备案镜像；跳转只指向发布方真实域名（产物中禁止 Google 中转链接）；不提供、也不引导任何绕过手段（D11/D12/D25/D26） |
| ICP 备案 | 大陆镜像启用前必须完成备案；"境外新闻聚合"的备案主体与内容范围需提前确认，备不下来就只运营海外主站，不在灰色地带硬上（D12） |
| 内容审核风险 | 发布前簇级筛查（§7.6）；"未包含"为描述性事实、不含推断；提供删除邮箱；`overrides.json` 预留单条/单国隐藏开关，被要求时可分钟级下线 |
| 筛查的边界 | 筛查是**内容级**控制，不改变站点性质。不得对外暗示"筛过就等于合规"；备案审查看的是"境外新闻聚合"这一性质（§7.6.7） |
| 筛查可审计 | 剔除数量、命中规则数、当前模式全部写入 `status.json` 并在 `/status` 公开，避免"悄悄删了东西" |
| 隐私 | 无账户、无 Cookie、无分析脚本 |
| 数据删除 | 完整快照只保留 2 份、历史摘要 14 份，自动清理；收到请求可手动删除对应 slot 并重新渲染 |

---

## 16. 测试策略

### 16.1 单元测试（Vitest）

| 模块 | 用例 |
|---|---|
| `clean` | 后缀剥离、空白归一、NFC、空标题 |
| `links` | 旧格式解码、非法载荷、非 Google 链接、失败回退 |
| `dedupe` | 同发布方近似、跨发布方近似、保留顺序 |
| `cluster` | 同事件合并、同主题不同事件不合并、实体冲突不合并、单国重复计数 1 |
| `topics` | 锚点分类、`other` 占比、软分类归一 |
| `metrics` | 分母变化、阈值边界、样本不足、留一均值、`topConsensus` 的 null 条件 |
| `translate` | 缓存命中不再调用、配额守卫拦截、DeepL→m2m100 降级、两者皆失败回退原文 |
| `history` | lineage 继承、断档重置、连续天数跨日 |
| `render` | HTML 转义、链接协议、无数据占位、`lang` 属性 |
| `schema` | 合法/非法快照、可空字段 |

### 16.2 校准（`npm run calibrate`）

- 输入：`tests/fixtures/labeled-pairs.jsonl`，至少 300 对，覆盖 10 种语言。
- 每行：`{"a":"...","b":"...","langA":"ja","langB":"de","label":1}`。
- 输出：阈值 0.70–0.90 的 Precision / Recall / F1 表。
- 选择规则：**Precision ≥ 0.90 的最低阈值**；若无法达到，CI 失败并提示补充样本。
- 结果写入 `docs/calibration.md`（生成文件，人工审阅后提交）。

### 16.3 渲染与契约

- Ajv 校验 `latest.json`、`status.json`、快照。
- 渲染快照测试：固定 fixture → 关键 DOM 结构断言（不用整页快照，避免噪声）。
- 恶意标题 fixture：`<img src=x onerror=alert(1)>`，断言输出为转义文本。

### 16.4 E2E（Playwright）

1. 首页 15 张卡片、每张 3 条。
2. 地区筛选只显示对应卡片，`aria-pressed` 正确。
3. 禁用 JS 后页面仍完整可读（仅倒计时静态）。
4. 键盘 Tab 可到达所有标题链接。
5. 译文切换生效并持久化。
6. 外部链接带 `rel="noopener noreferrer nofollow"`。
7. axe 扫描无 critical/serious。

### 16.5 确定性

- 同一 fixture 连续跑两次，除时间戳外输出哈希一致。
- 模型 revision、阈值常量写入输出，便于复现。

---

## 17. CI/CD 与运维

### 17.1 `.github/workflows/snapshot.yml`

```yaml
name: snapshot
on:
  schedule:
    - cron: '0 6,16 * * *'      # 14:00 / 00:00 Asia/Shanghai
  workflow_dispatch:
    inputs:
      force:
        type: boolean
        default: false

permissions:
  contents: write

concurrency:
  group: snapshot
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - uses: actions/cache@v4
        with:
          # transformers.js 的默认缓存目录是工作目录下的 .cache，
          # 不是 Hugging Face Python 生态的 ~/.cache/huggingface（见 §8.1）
          path: ${{ github.workspace }}/.cache
          key: transformersjs-${{ hashFiles('package-lock.json') }}
      - name: Test
        run: npm test -- --run
      - name: Snapshot
        env:
          TZ: Asia/Shanghai
          FORCE: ${{ inputs.force }}
          MODEL_CACHE_DIR: ${{ github.workspace }}/.cache
        run: node src/scripts/run.mjs
      - name: Render
        run: node src/scripts/render.mjs
      - name: Commit
        run: |
          git config user.name  "snapshot-bot"
          git config user.email "bot@users.noreply.github.com"
          git add data dist
          git diff --cached --quiet || git commit -m "chore(data): snapshot $(date -u +%Y-%m-%dT%H%MZ)"
          git push
```

注意事项：

- GitHub 的 `schedule` 使用 UTC，且可能延迟 5–30 分钟甚至跳过；页面显示实际时间，不承诺准点。
- 公共仓库 60 天无活动会停用定时任务；用每月一次手动 dispatch 或 keepalive 保持。
- 若 `npm test` 因网络相关用例失败，网络用例必须默认跳过（`SKIP_NETWORK=1`）。
- 数据提交会触发 Pages 构建；60 次/月远低于 500 次额度。
- 本 workflow **不跑 Playwright**：E2E 放独立的 `e2e.yml`（PR + 每日一次），否则每次抓取都要装浏览器，3 分钟预算会被撑到 10 分钟以上。
- `git push` 在并发 dispatch 时可能冲突；脚本需捕获失败并 `git pull --rebase` 重试 2 次（已在 §13 登记）。

### 17.2 Cloudflare Pages

- 构建命令：`npm run build`（= `node src/scripts/render.mjs`，不重新抓取）。
- 输出：`dist`。
- 环境变量：`NODE_VERSION=20`。
- 自定义域 + Always Use HTTPS。
- `_headers`：

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), camera=(), microphone=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: public, max-age=300, stale-while-revalidate=86400
```

### 17.3 运维手册（Runbook）

| 场景 | 动作 |
|---|---|
| 某国连续失败 | 查 `/status` → 本地 `probe-feeds.mjs --country XX` → 换 fallback → 提交 |
| 换国家 | 改 `feeds.json` 一项 → 本地跑 `probe` → 跑一次 `run` → 提交 |
| 阈值误报 | 收集误报样本 → 加入 `labeled-pairs.jsonl` → `calibrate` → 升 `algorithmVersion` |
| Pages 构建失败 | 查构建日志；本地 `npm run build`；回滚到上一提交 |
| 模型下载失败 | 检查 cache key；必要时临时关闭聚类（环境变量）并发布降级快照 |
| 版权/内容投诉 | 在 `overrides.json` 隐藏对应条目或国家 → 重新渲染 |
| 紧急下线 | Pages 暂停部署 或 回滚上一个 deployment |

---

## 18. 里程碑与任务拆分

| 阶段 | 内容 | 交付物 | 预估 |
|---|---|---|---|
| M0 数据通路 | 脚手架、`constants.mjs`、feeds、抓取、解析、快照、status、Schema | 能稳定产出 `latest.json` + `status.json` | 1.5 人日 |
| M1 聚类与标记 | clean/links/lang/embed/dedupe/cluster/topics/metrics/history + 单元测试 | 快照含四类标记 + `topConsensus` | 2.5 人日 |
| M2 首页渲染 | 模板、卡片、共识条、响应式、视觉规范、转义 | `dist/index.html` 可看 | 2 人日 |
| M3 辅助页与交互 | `/status`、`/about`、筛选、倒计时、译文切换、无 JS、a11y | 三页完整 | 1 人日 |
| M3.5 翻译管线 | `lib/translate.mjs`、缓存、配额守卫、双供应商降级 | 展示文本默认有中文译文 | 0.5 人日 |
| M4 部署与监控 | Actions、Pages、headers、`preflight` 硬校验、双托管脚本、runbook、告警 | 主站上线，镜像脚本就绪 | 1.5 人日 |
| M5 校准与验收 | 300 对标注、阈值校准、5 人可用性测试、文案审读（D22）、大陆可达性实测 | 校准报告、`copy-review.md`、验收记录 | 2 人日 |

**合计约 11.5 人日**（不含等待模型下载与线上观察）。其中 0.5 人日为内容筛查的流水线集成（引擎、预检 CLI 与单测已交付，见 §7.6.8）。

**条件性增项**：若 `probe-feeds.mjs` 显示新格式 `AU_...` 占比 > 20%，需追加 `links-new.mjs`（`batchexecute` 还原）+ 1–2 人日。这是 v1.3 转向后唯一可能让工期明显超支的项，因为解码失败会直接砍掉"每条都能跳原文"。

### 18.1 实现顺序的硬依赖

1. 先写 `src/lib/constants.mjs`，把 §5.8 的常量全部落进去；之后任何模块只引用、不写字面量。
2. 先做 `probe-feeds.mjs`，确认 15 国真实可用，再写抓取逻辑。
3. 先做 Schema，再做指标，避免字段反复改。
4. 聚类与阈值必须先有标注集；没有标注集就不要对外发布标记。
5. 渲染层在数据契约稳定后再写，避免返工。
6. 翻译必须排在指标之后：只有确定了"展示哪 61 条"，才知道翻译什么。顺序颠倒会把成本放大 3.7 倍且毫无收益。
7. `topConsensus` 必须在 `translate` 之前算完，否则共识条标签没有译文可挂。

---

## 19. 验收标准

### 19.1 功能

- [ ] 15 张卡片全部渲染，每张 3 条；失效国家有明确占位。
- [ ] 每条可点标题的 `href` 是解码后的发布方真实域名；产物中不存在任何 `news.google.com` 的 `href`（`preflight` 硬校验）。
- [ ] 解码失败的条目渲染为不可点文本，`meta` 仍显示来源名、域名与时间；页面不存在"看起来可点但必然打不开"的链接。
- [ ] 共识计数分母与有效国家数一致，tooltip 文案正确。
- [ ] "本期前 N 条未包含"只在健康、`itemsValid ≥ 12` 的国家出现，且 N 与该国实际条数一致。
- [ ] 顶部共识条：有符合条件的簇时出现，分母为实际有效国家数；`topConsensus` 为 `null` 时整个区块不渲染、不留空行；不可点击。
- [ ] 展示标题默认显示中文译文并可一键切原文（选择持久化）；译文缺失时回退原文，不出现空行。
- [ ] 偏移条有档位文本与屏幕阅读器文本。
- [ ] 连续 3 天、较上次突变在满足条件时出现，不满足时不出现。
- [ ] 地区筛选、倒计时、译文切换可用；关闭 JS 后内容完整。
- [ ] `/status`、`/about` 可访问，内容齐全。
- [ ] 筛查按簇执行：构造一个"某国命中、别国不命中"的 fixture，验证整簇被移除，**页面不出现"该国没报"**。
- [ ] 筛查剔除后每国样本仍为 15 条（回补生效）；回补后不足 12 条的国家按 §13 降级，不为筛查开例外。
- [ ] `SCREEN_MODE=review` 且有 soft 命中时，运行**不发布**、不覆盖上一份快照，并产出预检表；`auto` 模式下 soft 命中照常发布并计数。
- [ ] `status.json` 的 `screening` 字段完整（mode / softHits / hardHits / excludedClusters / excludedItems），`/status` 可见。

### 19.2 质量

- [ ] 聚类校准：Precision ≥ 0.90，Recall ≥ 0.70。
- [ ] 同一 fixture 两次运行输出一致（除时间戳）。
- [ ] Schema 校验通过；恶意 fixture 不产生可执行 HTML。
- [ ] axe 无 critical/serious；对比度全部通过。
- [ ] LCP < 1.5s（4G 模拟），首屏请求 ≤ 4，无第三方请求。
- [ ] 5 人可用性测试：至少 4 人能在 10 秒内指出"哪条是共识、哪国样本没包含、哪国最不同"。
- [ ] 单次翻译调用 ≤ 61 条；月字符数 < 40 万（守卫生效，超限自动停用翻译）。
- [ ] 稳态翻译缓存命中率 ≥ 60%（连续运行 3 天后统计）。
- [ ] 翻译全部失败时页面仍完整可读（原文回退），无空白标题。

### 19.3 运维

- [ ] 连续 3 次定时运行成功，有效国家 ≥ 13。
- [ ] 单国失败时页面降级正确，不产生错误标记。
- [ ] Actions 失败有通知；状态页能定位到具体源。
- [ ] `state/history.json` 保留 14 个 slot、完整快照仅 2 份，无孤儿文件。
- [ ] 单次提交体积 < 100 KB（§5.9）。
- [ ] 主站与大陆镜像部署的是同一份 `dist`（内容哈希一致），不存在两套产物。
- [ ] 链接解码率 ≥ 95%；低于该值时状态页醒目提示。

---

## 20. 风险登记（与实现相关）

| 风险 | 触发信号 | 缓解 |
|---|---|---|
| 聚类精确率不达标 | 校准 P < 0.90 | 先提高 `T_MATCH`、补实体；仍不达标则关闭"未包含"只保留共识；缩减国家数是最后手段（D16 已否决默认缩国） |
| 某国源长期不可用 | status 连续红 | fallback 直连源；仍失败则替换国家 |
| Google 链接格式变化 | 解码率骤降 | 保留原链接；更新解码器；状态页提示 |
| GitHub cron 漏跑 | 快照间隔 > 14h | 手动 dispatch；迁 Cloudflare Cron（仅抓取+写 KV，渲染仍静态） |
| 模型体积导致 CI 超时 | 运行 > 8 min | 量化模型、缓存、减少重试 |
| 译文质量差 | 用户反馈/抽检 | 抽样 50 条评估；若 DeepL 不达标则改 Workers AI 为主；仍差则默认展示原文（D13 可回退） |
| 翻译配额月中耗尽 | status 显示本月字符数 > 40 万 | 自动停翻、回退原文；优先翻译卡片标题、放弃未包含标签 |
| 备用池国家也不可用 | probe 连续失败 | 启用第二备用池（泰国 TH、沙特 SA、荷兰 NL、埃及 EG）；极端情况退为 14 国并在 status 与关于页声明 |
| "未包含"引发争议 | 社交平台反馈 | 文案降级 + 关于页说明 + 快速隐藏条目 |
| 大陆访问失败 | 反馈集中 | 明确受众；提供截图分享；不承诺大陆直连 |
| 内容同质化 | 回访下降 | V2 增加"今日最不同"置顶、周摘要 |

---

## 21. 原待决策项（v1.2 已全部决议）

v1.0 列出的 7 个阻塞项**已全部决议**，实现不再等待答复。决议内容见 §2.1，逐条对应如下：

| v1.0 待决项 | 决议 | 落点 |
|---|---|---|
| 1. 首发受众：大陆 / 海外中文 | **大陆用户**（v1.3 转向）：内容自包含 + 一套产物双托管；跳转降级为附加动作 | §2.1 D11、D12、D25–D27；§3.3；§6.4；§11.3；§12.2 第 7–8 条；§15 |
| 2. 是否默认展示标机翻 | 是，默认译文 + 可切原文；只翻展示文本 | §2.1 D13–D15；§7.5；§11.6 |
| 3. 是否接受本地多语言模型 | 接受（q8，约 120 MB），保留降级路径 | §2.1 D19；§8.1；§8.6 |
| 4. 未包含文案与中文审读 | 定稿为动态 N 句式；审读限于 3 处，产出 `copy-review.md` | §2.1 D21、D22；§12.2 |
| 5. 15 国还是 9 国语种圈 | 15 国 + 5 国备用池，缺位替换不缩减 | §2.1 D16；§5.2.1 |
| 6. 域名、反馈邮箱、仓库归属 | 仓库 `world-headlines-snapshot`；先 `*.pages.dev`；域名与邮箱上线前替换占位 | §2.1 D20；§17.2 |
| 7. 展示 3 条还是 5 条 | 3 条；另在顶部增设自动共识条解决"10 秒看懂" | §2.1 D17、D18；§11.2；§11.4 |

**仍为开放项的只有"外部事实"而非"产品决策"**：15 个 `ceid` 实测、链接解码成功率、模型加载耗时、翻译配额实际消耗。这些只能跑一遍才知道，已列入 §23 末尾与 §18.1。

---

## 22. 附：V1 不做但已预留的扩展点

- 分享卡片图生成（V2）：复用快照中的卡片数据，服务端渲染 PNG。
- 主题筛选（V2）：`item.topic` 已存。
- "哪些国在报"展开（V2）：`silentEvent.reportingCodes` 已存。
- 历史回看（V3）：快照文件即数据源。
- 更多国家（V3）：只改 `feeds.json`，但需重新校准阈值。
- 周摘要（V3）：基于 14 份快照聚合。
- 翻译供应商热切换（V2）：缓存键已含 `providerVersion`，换供应商不影响历史译文。
- 共识条展开"哪些国在报"（V2）：`topConsensus.reportingCodes` 已存。
- 备用池扩充（V2）：§5.2.1 记录的第二备用池。
- 大陆变体（V2，需单独决策）：`sourceProfile` 抽象已预留，只换取数适配层（D12）。

**永远不做**：账户、评论、个性化推荐、全文阅读、管理后台、用户端互动（筛选/切换/跳转除外）。

---

## 23. 修订记录（v1.1 / v1.2）

### 23.1 v1.1：实现级缺陷

本次只修**会导致实现出错、指标失效或功能静默消失**的缺陷；产品定位、架构、视觉方向未变。

| # | 位置 | v1.0 的问题 | v1.1 的修正 | 不修会怎样 |
|---|---|---|---|---|
| 1 | §5.8（新增） | 同一门槛出现三个值：§9.2 写 12、§10.2 写 15、§13 写 15 | 建立全局常量表，代码统一引用 `constants.mjs` | 实现者按就近段落取值，两条分支行为不一致，且无法回溯 |
| 2 | §8.3 | 缺失信号填 0.5 + 加法权重，使"有实体但不重合"需要 cos≥1.0 才能匹配，无实体标题需要 cos≥0.93 | 改条件权重归一化 + 显式 `gate()` | 跨语言匹配在大类上系统性失效，共识计数整体偏低，沉默标记几乎不出现 |
| 3 | §8.4 | 预筛余弦 0.68 会把"实体相同、措辞不同"的合法配对提前丢弃 | 预筛改为 0.55 且对实体重合放行 | 与 #2 叠加，进一步压低召回 |
| 4 | §8.1、§17.1 | CI 缓存 `~/.cache/huggingface`，但 transformers.js 的缓存目录是 `./.cache` | 显式设 `env.cacheDir`，缓存路径与 workflow 对齐 | 每次运行重新下载 120 MB 模型，CI 超时或限流 |
| 5 | §7.4（新增）、§5.1 | 全文未定义"每国 15 条"在哪一步产生 | 明确 `itemsRaw → 去重 → 截断到 limit` 的顺序与字段 | 样本口径随 RSS 返回条数漂移，偏移分位与连续天数跨天不可比 |
| 6 | §10.2、§1.3、§11.3 | 未包含要求 `itemsValid ≥ 15`；各国若长期不足 15 条，该行永久为空 | 门槛降至 12，文案用实际条数 N，并加 `partialSample` 提示 | 产品最核心的差异点在多数卡片上静默消失，日志无报错 |
| 7 | §5.3、§5.6、§5.9（新增）、§4 | 每天 2 次提交 14 份完整快照，git 历史一年增长 110–180 MB | 只留 2 份完整快照 + 14 份精简 `state/history.json` | 仓库逼近 GitHub 上限，且删除旧文件并不能回收历史 |
| 8 | §10.3、§5.7 | 用单一 `lastMedoidTitle` 做跨天继承 | 存 3 条代表标题 + 国家集合 + 实体三重条件 | 事件主线一漂移就断，"连续 3 天"几乎永不触发 |
| 9 | §5.3 示例 | `comparedTo` 指向未来快照（0600Z 对比 1600Z） | 改为 `2026-10-27T1600Z` | 照示例实现会拿到空集，突变计算恒为 null 或抛错 |
| 10 | §11.2、§11.8 | 整条状态栏 `role="status"`，倒计时每 30 秒刷新 | 仅健康文本用 `role="status"`，倒计时 `aria-live="off"` | 屏幕阅读器每 30 秒播报一次，页面不可用 |
| 11 | §11.9（新增） | 无任何 `<head>`/分享预览要求 | 补 title/description/OG/theme-color/favicon 清单 | 截图回流时链接无预览，第二入口失效 |

### 23.2 v1.2：决策落地

原 §21 的 7 个阻塞项与可行性文档 §8 的 7 个问题已全部决议（§2.1），并写入受影响章节。这是**首次把"待定"变成"可实现"**：

| 决议 | 影响章节 | 具体改动 |
|---|---|---|
| D11 / D12 受众与大陆版 | §12.2、§15 | 关于页增加"受众与可达性"声明；合规表增加"不提供也不引导绕过手段" |
| D13–D15 机翻 | §7.5（新增）、§3.1、§3.2、§10.5、§11.3、§11.6、§13、§16.1、§19 | 新增整条翻译管线：范围 ≤61 条、DeepL→m2m100 双供应商、缓存与配额守卫、失败回退原文 |
| D16 15 国 + 备用池 | §5.2.1（新增） | 5 个备用国与替换规则；`countriesConfigured` 恒为 15 |
| D18 顶部共识条 | §5.3、§5.4、§11.2、§11.4、§19.1 | 新增 `topConsensus` 字段、HTML 区块、视觉规范与验收项；明确不可点击 |
| D17 / D20 / D21 / D22 | §2.1、§12.2、§19 | 展示 3 条不变；仓库改名；文案定稿；审读范围收窄到 3 处 |
| D23 / D24 口径与告警 | §10.4、§13 | 明确"上一次"= 同 slot 序列的前一份；连续 3 次才告警/切 fallback |
| 交付节奏 | §18 | 新增 M3.5 翻译管线 0.5 人日，合计 10.5 人日 |

**为什么这些决议是"最佳"而非"折中"**：

- **机翻只翻 61 条**把成本压到 1/3.7，同时不碰任何指标——翻译质量再差也只影响可读性，不影响共识/未包含的正确性，这是**把不确定性隔离在非核心路径**。
- **加顶部共识条**用一条自动计算结果满足验收标准，比让用户扫 45 条标题更可靠，且因为是计算结果，不违背"不人工挑选"的原则。
- **15 国 + 备用池**把"国家数"和"可用性"解耦：某国源坏了换国，而不是让整个世界缩小。

> 注：本节"受众选海外不是退让"的论证在 v1.3 已被推翻（受众改为大陆用户），保留原文仅为记录当时的推理链。现行结论见 §23.4。

### 23.3 未验证项

**必须在真实网络环境复核，本文档不假装已验证**：

1. 15 个 `ceid` 是否全部有效、每国实际返回条数（尤其 `BR:pt-419`、`MX:es-419`）。
2. Google News RSS 链接的新旧两种格式比例，以及旧格式离线解码率、`HEAD` 跳转成功率。**v1.3 起这是发布阻断项**——决定要不要写 `links-new.mjs`。
   **2026-10-28 首次真实探测（20 国 / 696 条）**：20/20 国 HTTP 200，每国 26–38 条（全部 ≥15，备用池一个都不用动）；696 条**全部是 `CBMi` 前缀，但明文 URL 解码率 0%**。这否定了"旧格式可离线解码"的假设，推测载荷已变为「`CBMi` 包装 + 内嵌 `AU_` token」，待 `check-links.mjs` 对样本确认。若确认，`links-new.mjs` 是必做项而非可省项。
3. `@huggingface/transformers` 与 `Xenova/multilingual-e5-small` 在当前 Node 20 下的加载耗时与内存峰值。
4. 翻译质量与配额：DeepL Free → 中文的实际可读性，以及按 §7.5 口径的月消耗。
5. **大陆可达性实测**（v1.3 新增）：自定义域名在大陆三大运营商下的打开率与首屏时间；这一项无法由构建环境代测，只能由真实用户在多点实测。

第 1、2 项由 `src/scripts/probe-feeds.mjs` 一次运行覆盖，是本项目**最先要做的事**；第 5 项决定"要不要做镜像"，属发布前验收。未通过第 1、2 项前不应对外承诺"共识/未包含"的准确性（与 §7 放行条件一致）。

### 23.4 v1.3：受众转向中国大陆

**触发原因**：受众判断由"海外中文用户"改为"中国大陆用户"。这不是文案调整，而是三条硬约束同时收紧，导致产品形态从"对比窗口 + 入口"变为"内容自包含的对比结果页 + 可选出口"。

| 改动 | 位置 | 内容 |
|---|---|---|
| 受众与形态 | §2.1 D11、§1.3 | 内容自包含成为硬口径；跳转降级为附加动作 |
| 托管 | §2.1 D12、D20；§3.3 | 一套 `dist`、双托管；公开发布必须绑自定义域名，`pages.dev` 不对外；镜像需备案 |
| 链接 | §2.1 D25、D26；§6.4、§6.4.1；§11.3 | 只允许发布方真实域名；解码失败不渲染链接；解码率目标 80% → **95%**；新增 `preflight` 硬校验；新格式解码升格为阻断项 |
| 卡片信息层级 | §11.3 | `meta` 固定为「来源名 · 域名 · 时间」——大陆用户多数只能看到这一层 |
| 文案 | §2.1 D27；§12.2 | 传播语改为「今天 15 国都在报什么」，禁用"沉默/封锁/审查" |
| 合规 | §15 | 新增 ICP 备案与内容审核风险两行 |
| 验收 | §19.1、§19.3 | 增加"无 Google 中转链接""不可点条目不伪装""主站与镜像同一产物""解码率 ≥95%" |
| 工期 | §18 | +0.5 人日（preflight、双托管脚本；`links-new.mjs` 视探测结果再估 1–2 人日） |

**必须诚实说清的三件事**：

1. **大陆用户看得到内容，但多数原文点不开**。即使解码成功，NYT/BBC/Spiegel 等域名本身也需要境外网络。所以产品的价值必须靠页面自足——这正是为什么"内容自包含"被提到 §1.3 的口径表里，而不是当作一句免责声明。
2. **备案是镜像的唯一前置条件，且不保证能过**。"境外新闻聚合"性质的站点备案难度高、内容审核口径严。批不下来就只剩海外主站，大陆访问质量不稳定。这条不解决，产品在大陆就只可能是"小范围可用的个人项目"，不是稳定产品。
3. **"谁在沉默"作为卖点在大陆不可用**。界面已降级为"本期前 N 条未包含"，传播语进一步改为「今天 15 国都在报什么」。这不是自我审查，而是承认：一个传不出去的正确结论，价值为零。

**若后续要在大陆稳定运营，只有三条路，且互斥**：

| 路径 | 做法 | 代价 |
|---|---|---|
| A（当前方案） | 海外主站 + 自定义域名，可选备案镜像，配 §7.6 内容筛查 | 大陆访问质量不稳；备案可能批不下来 |
| B | 换境内可访问源，做"中文媒体议程对比" | 不再是"世界头条"，产品定义改变；但合规风险最低 |
| C | 只做截图传播，站点服务海外 | 放弃站点留存，数据无法验证 |

选 B 等于换产品，需要重新做可行性评估，不在本设计范围内。

### 23.5 v1.4：用内容筛查替代合规改造

**决定**：不改变站点性质，改为在发布前按 §7.6 做内容筛查（簇级剔除 + 指标前 + 回补）。承接 v1.3 的路径 A。

| 改动 | 位置 | 内容 |
|---|---|---|
| 新增章节 | §7.6 | 三条硬约束（簇级/指标前/回补）、管线顺序、两种模式、规则与决定文件、披露口径、局限、工具 |
| 决策补录 | §2.1 D28、D29 | 簇级剔除；默认 `review` 模式，规则稳定后切 `auto` |
| 常量 | §5.8 | `CANDIDATE_POOL_EXTRA=10`、`MAX_SOFT_HITS=5`、`SCREEN_MODE=review` |
| 口径 | §1.3 | "剔除"的定义：簇级、指标前、回补 |
| 合规 | §15 | 新增"筛查的边界""筛查可审计"两行 |
| 验收 | §19.1 | 4 条筛查验收，含一条专门验证"不产生错误指控"的 fixture |
| 数据契约 | §13、§12.1 | `status.json` 增加 `screening` 字段 |
| 工具 | `src/lib/screen.mjs`、`src/scripts/screen-preview.mjs`、`src/config/sensitive.json`、`tests/unit/screen.test.mjs` | 已交付并自测 |
| 工期 | §18 | +0.5 人日（引擎已交付） |

**为什么选这个方案**：合规改造（备案 + 境内主体）的成本与不确定性都远高于产品本身，而且大概率批不下来；内容筛查的成本是 0.5 人日 + 每次 5 分钟，能覆盖传播侧与单条风险。这是一个**成本匹配风险**的选择，不是"合规可以不做"。

**必须记住的两条**：

1. **条级剔除会造假**。只剔某国那一条，页面就会说"12 国在报、该国没报"，而该国报了。这是本方案里唯一能真正毁掉产品可信度的实现错误，已写成 §7.6.1 的第一条硬约束与 §19.1 的专门验收项。
2. **筛查不解决备案**。它降低内容风险，不改变"境外新闻聚合站"这一性质。别在对外材料里暗示"我们筛过了所以合规"。
