# 世界头条切片 · World Headlines Snapshot

每 12 小时抓一次 15 个国家的 Google News Top Stories 样本，自动算出**共识、本期未包含、议程偏移、时间变化**四类标记，渲染成一个静态页。

- 产品与算法设计：[`docs/02-detailed-design.md`](docs/02-detailed-design.md)
- 可行性与风险：[`docs/01-feasibility-review.md`](docs/01-feasibility-review.md)

**当前状态：只有"验证工具链"这一层可用。** 抓取、聚合、渲染、部署都还没写。这是有意的——整个项目最大的未知是"Google News 到底返回什么"，不先量出来，后面全是猜。

| 模块 | 状态 |
|---|---|
| `src/config/feeds.json`（15 国 + 5 备用） | ✅ |
| `src/lib/rss.mjs`（RSS 解析 + 链接分类/解码） | ✅ 含单元测试 |
| `src/lib/screen.mjs`（内容筛查引擎） | ✅ 含单元测试 |
| `src/config/sensitive.json`（筛查规则模板） | ✅ 默认 0 条 hard |
| `src/scripts/probe-feeds.mjs`（探针） | ✅ |
| `src/scripts/make-pairs.mjs`（生成标注候选） | ✅ |
| `src/scripts/calibrate.mjs`（阈值校准） | ✅ |
| `src/scripts/screen-preview.mjs`（筛查预检） | ✅ |
| 聚合、标记、渲染、翻译、部署 | ⬜ 待做 |

---

## 三步走

前两步**不需要 `npm install`，不需要任何依赖**，只要 Node ≥ 20。第三步需要装一个模型包。

### 第 1 步：跑探针

**推荐在 GitHub Actions 里跑**（[`.github/workflows/probe.yml`](.github/workflows/probe.yml)）。生产抓取本来就跑在 Actions 的海外 runner 上，在这里跑验证的是"流水线能不能取到数"；本地挂 VPN 跑只能验证"我的笔记本能取到数"，对上线没有意义。

```
git init && git add -A && git commit -m "init"
# push 到 GitHub 后：Actions → probe → Run workflow（默认 --all）
```

结果直接出现在 Job Summary 里，报告与原始 JSON 作为 artifact 上传。

**本地跑也可以**，前提是真能访问 `news.google.com`：

```bash
node src/scripts/probe-feeds.mjs --all
```

⚠️ 挂了 VPN 仍然 `fetch failed` 的最常见原因：**Node 的 fetch 默认不读 `HTTP(S)_PROXY`**，所以系统代理 / 规则模式对脚本不生效。解决：让 VPN 走 TUN / 全局（虚拟网卡）模式；或 Node ≥ 24 时设 `NODE_USE_ENV_PROXY=1`。脚本检测到代理变量会主动提示。

看三件事：

1. 每国返回多少条，是否 ≥ 12（少于 12 的国家要换，见设计 §5.2.1）；
2. `旧/新` 列 —— 链接格式分布；
3. `解码` 列 —— 旧格式离线解码率。

**这一列决定要不要额外做 1–2 天的工**（设计 §6.4.1）。把 `docs/probe-report.md` 发给设计方看结果。

可选：`--head` 会额外探测新格式链接能否还原原始 URL（慢一些，每国最多 3 次）。

### 第 2 步：生成标注候选

```bash
node src/scripts/make-pairs.mjs
```

产出 `tests/fixtures/labeled-pairs.csv`，约 300 对跨语言标题，按五层抽样（同源近似 / 同国不同源 / 同语言跨国 / 共享专名 / 纯跨语言随机）。

**人工标注**：用 Excel 或 VS Code 打开，只填 `label` 列。

- `1` = 两行讲的是同一件事
- `0` = 不同事件（哪怕主题相同）
- 拿不准就**留空**，会被跳过

判据是"读者会不会认为是同一件事"，不是"主题是否相同"。300 行约 40 分钟。

### 第 3 步：校准阈值

```bash
npm install          # 只为装 @huggingface/transformers（约 120 MB 模型首次会缓存到 ./.cache）
node src/scripts/calibrate.mjs
```

产出 `docs/calibration.md`：阈值曲线、分层精确率/召回率、推荐写入 `constants.mjs` 的常量。

**达标标准：精确率 ≥ 0.90。** 达不到脚本会直接告诉你 FAIL，并给出处置顺序——不要自己放宽，错标"某国漏报"的代价远大于漏标。

没有网络装包时，可以先跑 `--provider tfidf` 验证流程（结果只对同语言有效，不能当阈值用）。

---

## 内容筛查（面向大陆发布）

发布前检查敏感话题。**默认 `review` 模式：有命中就不自动发布，等人确认。** 每 12 小时一次，实际只看被机器挑出来的那几条，约 5 分钟。

```bash
node src/scripts/screen-preview.mjs --check   # 先看规则清单，确认没有乱写的 hard 规则
node src/scripts/screen-preview.mjs           # 对最近一次抓取做预检，输出 data/review/screen-<时间>.md
```

预检表里逐行判断：**保留就留空，剔除就在最后一列写 `x`**。勾掉的写进 `src/config/screen-decisions.json`（`id` 列已给出，是标题 sha256 前 16 位）。全部保留就什么都不用改。

### 三条不能违反的规则

1. **按事件簇剔除，不按条。** 只剔某国那一条，页面就会显示"这件事 12 国在报、该国没报"，而该国其实报了——产品自己造一条错误指控。这是唯一能真正毁掉可信度的错误。
2. **剔除发生在指标计算之前**，并从 rank 16 起回补，保持每国样本 15 条。
3. **`hard` 规则必须少而准。** 它会被自动剔除、不经人工；误杀直接改变共识数字。

### 规则怎么填

- `src/config/sensitive.json`：只有机制 + 3 条通用示例，可以直接删掉换成自己的。
- `src/config/sensitive.local.json`：地域性/时效性规则写这里，**已 gitignore**。仓库不放具体词条清单。
- 白名单 `whitelist.terms` 只压 `soft`，压不住 `hard`。

规则稳定后（建议观察两周）再切 `SCREEN_MODE=auto`：soft 命中照常发布只记数，hard 仍自动剔除。

**筛查不解决备案。** 它降低的是内容级与传播侧风险；备案审的是"境外新闻聚合"这个站点性质。别在对外材料里暗示"筛过就等于合规"。

---

## 自测（不需要网络）

```bash
# 离线 fixture 跑通探针
node src/scripts/probe-feeds.mjs --only US,DE --fixture tests/fixtures/feeds

# 单元测试（注意：某些沙箱里 node --test 会因 spawn 受限而失败，可直接跑文件）
node --test tests/unit
# 或
node tests/unit/rss.test.mjs
```

## 目录

```
src/
  config/feeds.json        唯一手工维护的清单：15 国 + 5 备用
  config/sensitive.json    筛查规则模板（地域性规则放 sensitive.local.json，不入库）
  lib/rss.mjs              零依赖 RSS 解析 + Google 链接分类/解码
  lib/screen.mjs           内容筛查引擎（簇级 / 词边界 / 白名单）
  scripts/
    probe-feeds.mjs        探针（放行条件 1）
    make-pairs.mjs         生成标注候选
    calibrate.mjs          阈值校准（放行条件 2）
    screen-preview.mjs     筛查预检（发布前检查）
tests/
  unit/rss.test.mjs
  unit/screen.test.mjs
  fixtures/feeds/          离线 RSS 样例（假数据，仅供自测）
docs/
  01-feasibility-review.md
  02-detailed-design.md
```

## 注意

- `tests/fixtures/feeds/*.xml` 是**假数据**，域名全是 `*.example.com`，只用于离线自测，不代表任何真实抓取结果。
- `docs/probe-report.md`、`data/probe/` 都由探针生成，已 gitignore。
- **VPN 只解决"你能不能跑"，不解决"用户能不能打开"。** 产品仍然按内容自包含设计（§1.3），不能把"用户自备 VPN"写进前提——能挂 VPN 的人，恰好是最不需要这个产品的人。
- 面向大陆用户的两个前置事实尚未确认：**备案能否通过**、**自定义域名在大陆的实际可达性**。这两项不是代码能解决的，见设计 §23.4。