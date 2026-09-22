# Zug —— 德国铁路晚点预测

基于 zugfinder Pro 实时数据 + PieBro 历史库的德铁晚点预测 Web 应用。
输入车次（如 `ICE 578`）即可看到逐站晚点、准点概率、取消概率与晚点成分拆解；
也支持粘贴 bahnapp 行程链接自动解析多段行程。

## 结构

| 文件 | 作用 |
|---|---|
| `server.js` | Node 服务：路由、缓存（内存+磁盘）、并发合并、行程抓取 |
| `train_insight.py` | 预测主逻辑：zugfinder 实时采集 + 特征装配 + 模型推理 |
| `predictor_worker.py` | **常驻**预测 worker（5099），模型只加载一次，避免每次请求 fork |
| `public/` | 前端（index.html / app.js / style.css / i18n.js） |
| `vendor/zugfinder_pro.py` | zugfinder Pro 客户端 |
| `start-linux.sh` / `start-serve.sh` | 启动脚本（会加载 `.env`） |

## 部署要点

```bash
npm install
cp .env.example .env      # 按需填写
# Python 侧需 lightgbm / scipy / pandas / numpy
```

### 不在仓库里的内容（需自行提供）

- **`secrets/`** —— zugfinder 账号（email/password，两行一组）。
  仓库是公开的，凭据**绝不入库**。`train_insight.py` 会按
  `ZUGFINDER_CRED` → `secrets/account.txt` 的顺序找主凭据，
  备用账号池自动发现 `secrets/ac2.txt`、`secrets/ac(2).txt`。
- **`data/`** —— 约 19GB：模型（`delay_model`）、PieBro parquet、影响分析数据。
  体积过大不入库。
- **`.env`** —— 运行配置（见 `.env.example`）。

## 运行

```bash
bash start-serve.sh          # Web 服务（3000）
bash /root/ensure_worker.sh  # 常驻预测 worker（5099），幂等
```

`server.js` 默认把预测交给 `http://127.0.0.1:5099` 的常驻 worker；
worker 不可达时**会静默降级**为每请求 fork 一个 python（冷查询 60s+，
并发还可能 OOM），所以 worker 必须保持存活。

## 已知约束

- **冷车次首查（实测 8~12s，热缓存毫秒级）**：2026-09-23 已把主路径瓶颈逐个拆除，
  冷查询端到端 34.0s → 7.9s：
  - `db_bahn_expert` 实时晚点：TLS keep-alive + 限流间隔 3.5s→0.4s，10.2s → 0.9s；
  - PieBro 历史查询：结果落盘缓存 24h（`~/.cache/train_insight_piebro/`），4.1s → 毫秒级；
  - zugfinder 8 天采集：分片并行（默认 3 线程，每线程独立会话），18.1s → 5.3s；
  - worker 排队：闸门满时 FIFO 等待最长 45s 而非秒拒 503，高峰期 45s 窗口内吞吐 1 单 → 4 单；
  - 空闲预热：worker 空闲 5 分钟后自动回补热门车次的历史天缓存（热度统计查 `worker:5099/hot?n=10`）。
  各项均可经 `.env` 调优/回退（见 `.env.example`「预测 worker 与抓取调优」）。
  对 zugfinder 不覆盖的车次（境外车、不存在车次）已加快速失败：
  连续 `ZUGFINDER_EMPTY_ACCOUNT_LIMIT`（默认 3）个账号「登录成功、未限流、
  但零数据」即判定不覆盖并提前收工，实测 45–56s → 9–15s。
- **行程抓取（bahnapp.link）依赖非中国大陆的住宅/移动 IP 出口**：该站用 CloudFront
  WAF 按**客户端出口 IP** 封禁。沙箱直连出口是腾讯云 CN（AS45090），必拿到拒绝页；
  需经 `ZUGFINDER_SOCKS5`（住宅/移动 IP）出去。**出口池 + 自动故障转移**见下节。

### 行程抓取出口池（多出口冗余 + 主动探测）

**为什么需要**：唯一可用出口曾是一台德国手机（Tailscale exit node）。手机一离线，
行程抓取就彻底挂 —— 单点。现在把出口做成**池**，任一出口失效自动切下一个。

**配置**（`.env`，细节见 `.env.example`）：

```bash
ZUGFINDER_SOCKS5=#k30pro@socks5h://127.0.0.1:1080          # 主出口
ZUGFINDER_SOCKS5_EXTRA=#note12@socks5h://127.0.0.1:1081    # 追加出口（逗号分隔，必须单行）
JOURNEY_CHANNEL_FALLBACK=socks,relay                        # 不含 direct（直连必被拦）
```

**行为**：
- 按池顺序尝试出口；**逐出口熔断**（连续 3 次通道失败 → 该出口冷却 60s，其他出口不受影响）。
- **只**在通道层失败（连不上/握手失败/DNS/TLS）时切换出口；语义失败（WAF 拒绝页、
  链接失效、解析失败）**不**切换 —— 换出口也一样，避免空转。
- 所有出口 + relay 都不可用 → 返回 `502 E_JOURNEY_PROXY`（含 `channel_code` 与
  `tried`），**不回退直连**（直连只会被 WAF 拦，给出误导性结果）。
- **主动探测**：每 90s 用真实业务路径探活各出口，提前把掉线出口标为不健康，
  故障转移瞬时发生（熔断中的出口跳过，健康出口降频，对目标站友好）。

**观测**：
- `GET /api/debug` → `journeyChannels`：每个出口的 `state / circuit_open / fails /
  last_code / last_ok_age_s / served`，`stats`（成功/降级/全失败计数），`recent`（最近通道事件）。
- `GET /api/health` → `checks.journey_proxy`：出口池整体健康 + 各出口状态。

**可能的备用出口**（任选，配置即成，互不冲突）：
1. 第二台手机作 Tailscale exit node → 填入 `ZUGFINDER_SOCKS5_EXTRA`。
2. 家里常开机器跑住宅出口 agent（反向 WS 隧道，住宅 IP 出口，最稳）。
3. 自有德国 VPS / 住宅 SOCKS5 地址。

> ⚠️ **反模式（已逐一实测证伪，勿重试）**：bahnapp 的封锁是**纯客户端 IP 判定**。
> 改 `hosts`、逐个换 CloudFront 边缘 IP、伪造 User-Agent / `Accept-Language: de-DE`
> —— 全部无效。唯一出路是换一个非中国大陆的出口 IP。
