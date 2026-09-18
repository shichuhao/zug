# QA 第 3 轮 · 整改状态对照表

> **整改时间**：2026-09-19（柏林）
> **代码库**：`https://github.com/shichuhao/zug`，提交 `3e030fe` + `184d7c8`
> **部署状态**：⚠️ **尚未上线** —— 线上 `a7b09cb25afa46905.bj6.agentos-app.net` 仍是 `94bc0b4`（manifest 仍 404）。
> 按 Shi 指示先累积代码改动，部署通道确认后统一发布。
> **一行结论**：16 项全部有处置；其中 8 项为代码中原本已有（QA 实测条件不符或时序早于提交），8 项本轮新做。唯一未达标项是「`/api/train` ≤5s」，属数据源抓取硬约束。

---

## 一、逐项状态

| # | 项目 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | 注册/登录无限流 | ✅ **代码已有 + 线上实测生效** | `RATE_LIMITS`：注册 10min/5、登录 5min/20。线上实测第 6 次注册 → **429**（QA 报告"6 次全 200"与本轮实测不符，应为时序早于 `0b088fc` 提交或测试未计 IP）。本轮补 `Retry-After` + `E_RATE_LIMITED` i18n |
| 2 | 密码强度无校验 | ✅ **本轮新增** | 服务端硬校验 8–128 位且含字母+数字（`passwordIssue()`），前端预校验同步。实测 `"123"` → `400 {"error":"E_PASSWORD_TOO_SHORT"}` |
| 3 | Token 存 localStorage | ✅ **本轮改为 httpOnly Cookie** | `Set-Cookie: td_token=…; HttpOnly; SameSite=Lax`（https 下加 `Secure`）。前端 `authHeaders()` 返回空、`credentials:"same-origin"`，登录时顺手清掉旧 localStorage token。实测：登录下发 → Cookie 读 `/api/me` 成功 → 登出清零 |
| 4 | 分享链接无过期 | ✅ **代码已有 TTL + 本轮明示** | `SHARE_TTL_MS` 默认 7 天，`loadShare()` 读时校验过期并删文件，启动 `pruneShares()`。本轮 POST/GET 响应新增 `expires_at` / `ttl_days`，过期行为对调用方可见 |
| 5 | 评论无反垃圾限流 | ✅ 代码已有 | `comment_post` 1min/5 条、`comment_like` 1min/60 次 |
| 6 | 评论图片 EXIF/MIME | ✅ 代码已有 | `sniffImageType()` magic bytes 校验（不再信任 data URL 的 MIME 声明）+ `tools/strip_exif.py` 剥离 GPS；剥离失败降级放行不阻断上传 |
| 7 | 主查询 ≤5s | ⏸ **部分达成** | 已做：① 预热改走常驻 worker（模型已常驻，不再每趟 fork 3.4GB python），内存门槛分档 6000→1200MB —— 此前门槛常年不满足，预热几乎每轮被跳过，热门车次永远冷启动；② 全站响应 gzip（首页 31KB→**9.6KB**、app.js 249KB→**76KB**）。**未达成**：冷门车次仍需 zugfinder 实时抓取（8 天 × 限流间隔），属数据源硬约束 |
| 8 | 评论字段名不兼容 | ✅ **本轮新增** | `firstDefined(content, text)`，两个字段名都收（content 优先）；回复同步支持 |
| 9 | 错误文案 i18n | ✅ **本轮统一** | 新增 `apiFail()`：`error` 恒为稳定错误码 `E_XXX`，`message` 为中文兜底；前端 `SERVER_ERR_CODES`（22 条）按码查 i18n，中文串映射保留为兜底，三语（zh/en/de）补齐缺失 key |
| 10 | 分享过期/鉴权 | ✅ 见 #4 | 保持「公开可读」设计，改为**快照内不含 PII**（`sanitizeSharePayload` 白名单）+ TTL 明示 |
| 11 | app.js 未拆分 | ✅ **本轮拆分** | 249KB 单体 → `app.js` 206KB + `auth.js` 18.6KB + `comments.js` 27KB；`index.html` 中 `defer` 顺序加载（auth 先于 comments）。跨文件仅单向依赖（app.js 不引用另两者），已 grep 校验 |
| 12 | manifest.json 缺失 | ✅ **本轮新增** | `public/manifest.json` + 192/512/512-maskable 图标（`tools/gen_icons.js` 纯 Node 生成，零新依赖）+ `theme-color` + `apple-touch-icon` |
| 13 | 图表无障碍 | ✅ **本轮新增** | `#chartStations` 加 `tabindex="0"` + Enter/Space 触发放大（与点击等价），关闭后焦点由已有逻辑返回触发元素 |
| 14 | 深色模式无过渡 | ✅ **本轮新增** | `*` 选择器 180ms 颜色过渡（优先级 0，不覆盖既有 transition）+ `prefers-reduced-motion` 下关闭 |
| 15 | Modal 焦点不完整 | ✅ **本轮补齐** | 评论 lightbox 记录 `document.activeElement`，关闭后归还焦点（图表 lightbox 原已实现） |
| 16 | 历史链路 | ✅ **已实测闭环** | `POST /api/login`（取 Cookie）→ `GET /api/routes` → **`data/history.json` 被创建并写入** → `GET /api/history` 回显该条；回填不存在 id → `404 E_HISTORY_NOT_FOUND`。**QA 怀疑的「仅更新不创建」不成立**：`recordHistory()` 对空列表用 `|| []` 后 unshift，本就是创建语义。上次复测拿到空数组，最可能是请求未带有效凭证（旧版 token 只在 localStorage，curl 无 `Authorization` 时该函数直接 return，静默不写） |

---

## 二、附带修掉的两个干扰项

| 项 | 说明 |
|---|---|
| `/api/me` 未登录返回 401 | 页面每次加载都会调用，401 让浏览器控制台每次留一条红色 `Failed to load resource`，淹没真实错误（QA 复测也被它干扰）。改为 **200 + `{user:null, logged_in:false}`**；其余需鉴权端点仍严格 401 |
| `package.json` 脚本指向不存在的文件 | 原为 `test:e2e → node test.js`（该文件不在本仓库）。改为 `start` / `icons` / `test:smoke` |

---

## 三、回归验证方式（可复现）

```bash
# 1) 起本地服务（Python 侧无 data/secrets 时会降级，不影响前端验证）
node server.js

# 2) 前端端到端冒烟（15 项：跨文件符号可用性 / 登录弹窗 / 弱密码拦截 /
#    canvas 无障碍 / 主题过渡 / manifest / 控制台零错误）
NODE_PATH=<含 playwright 的 node_modules> node tools/e2e-smoke.js
# 最近一次结果：15/15 通过

# 3) 接口侧抽查
curl -s -X POST localhost:3000/api/register -H 'Content-Type: application/json' \
     -d '{"email":"a@b.c","password":"123"}'          # → 400 E_PASSWORD_TOO_SHORT
curl -s localhost:3000/api/me                          # → 200 {"user":null,...}
```

---

## 四、未闭环 / 已知边界

1. **线上未更新** —— 上线前 QA 清单里的现象仍会复现（manifest 404 等）。部署通道未知，且 WorkBuddy「发布为应用」重新发布**存在覆盖沙箱内 `data/`、`secrets/` 的风险**（会丢线上用户/评论/分享数据），需 Shi 确认通道后再动。
2. **`/api/train` 冷门车次 ≤5s 未达成** —— zugfinder 实时抓取是硬约束。可选后续：首屏先出「车次基本信息 + 历史统计」卡片，预测结果异步补齐。
3. **`data/` 与 `secrets/` 不在仓库** —— 本地只能验证到前端与无状态接口；涉及模型推理的端到端（真实预测 → 历史写入 train 类型）需在有数据的机器上复测。

---

> 结论：安全 4 项（限流 / 密码强度 / httpOnly Cookie / 分享 TTL）、接口 2 项（字段兼容 / 错误码 i18n）、
> 工程 5 项（拆分 / manifest / 图表无障碍 / 主题过渡 / Modal 焦点）均已处置并附实测证据；
> 性能项为部分达成，剩余差距有明确的数据源层面的原因。
