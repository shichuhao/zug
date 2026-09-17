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

- **冷车次仍慢（约 45s）**：主因是 zugfinder 实时抓取（8 天 × 限流间隔）。
  已被缓存的车次命中即返回（毫秒级）。
  对 zugfinder 不覆盖的车次（境外车、不存在车次）已加快速失败：
  连续 `ZUGFINDER_EMPTY_ACCOUNT_LIMIT`（默认 3）个账号「登录成功、未限流、
  但零数据」即判定不覆盖并提前收工，实测 45–56s → 9–15s。
- **行程抓取（bahnapp.link）依赖住宅 IP 出口**：该站用 CloudFront WAF 按来源 IP
  封禁，机房 IP 会拿到拒绝页。当前走 `ZUGFINDER_SOCKS5` 配置的中转出口。
