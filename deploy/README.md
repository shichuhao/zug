# deploy/ —— 爬虫调度链（部署脚本收编）

本目录把**线上以绝对路径运行、仓库外**的 stops 爬虫调度脚本收编进版本控制，作为
**源真相（source of truth）**。线上副本仍在原绝对路径运行，二者内容保持一致。

> 目的：爬虫内存隔离的错峰/限内存逻辑此前只存在于沙箱内的裸文件里，不进 git。
> 收编后改动可被 review、回溯、diff，避免"线上跑的东西仓库里查不到"。

## 为什么需要它

预测 worker（`predictor_worker.py`，常驻约 3.6GB）与 stops 爬虫
（`scrape_zugfinder_stops.py`）**同处一个 8GB cgroup**。爬虫无上限地抓取/落盘会与
worker 一起把内存顶到临界区 → 内核回收抖动 → worker 推理变慢 → 行程腿的 100s 排队
闸门被打破 → 前端 spinner 长期"预测中"（即用户报告的"卡住"）。

对策分三层，全部在本目录脚本里：

| 层级 | 手段 | 脚本 |
|---|---|---|
| 刚性封顶 | 爬虫放进受限子 cgroup（`memory.max=2G` / `memory.high=1500M`） | `crawler_cgroup.sh` |
| 启动时机错峰 | worker 忙/未就绪/内存近 OOM 时，本次 tick 不启动 | `crawler_may_start.sh` |
| 运行期实时让路 | `SIGSTOP`/`SIGCONT` 冻结/恢复爬虫 | `crawler_yield_guard.sh` |
| 总装 | 幂等编排：确保 cgroup → 确保看门狗 → 门槛判定 → 启动并入组 | `start_stops.sh` |

## 文件与线上路径对照

| 本目录文件 | 线上绝对路径 | 职责 |
|---|---|---|
| `start_stops.sh` | `/root/start_stops.sh` | 爬虫启动总装（幂等，断点续跑） |
| `crawler_cgroup.sh` | `/root/zugfinder/crawler_cgroup.sh` | 建/改子 cgroup，把在跑爬虫移入 |
| `crawler_may_start.sh` | `/root/zugfinder/crawler_may_start.sh` | 启动门槛：worker 空闲 + 内存宽松 |
| `crawler_yield_guard.sh` | `/root/zugfinder/crawler_yield_guard.sh` | 10s 轮询看门狗，忙则 STOP、闲则 CONT |

## 调用链（谁在调这些脚本）

```
keepalive.sh   (每 60s)   ─┐
reconnect.sh   (重启一次性) ─┼─> bash /root/start_stops.sh
                            ┘        │
                                     ├─> bash /root/zugfinder/crawler_cgroup.sh
                                     ├─> nohup bash .../crawler_yield_guard.sh   (看门狗自愈)
                                     ├─> bash .../crawler_may_start.sh            (门槛)
                                     └─> python3 scrape_zugfinder_stops.py ...    (启动并入 cgroup)
```

> 注意：调用方用的是**绝对路径**（`/root/...`），不读本目录。本目录仅作源真相与 diff 之用。

## 部署与同步（重要）

线上脚本**独立于仓库运行**，修改本目录后必须**手动同步到线上路径**才会生效：

```bash
cp deploy/start_stops.sh         /root/start_stops.sh          && chmod +x /root/start_stops.sh
cp deploy/crawler_cgroup.sh      /root/zugfinder/crawler_cgroup.sh      && chmod +x /root/zugfinder/crawler_cgroup.sh
cp deploy/crawler_may_start.sh   /root/zugfinder/crawler_may_start.sh   && chmod +x /root/zugfinder/crawler_may_start.sh
cp deploy/crawler_yield_guard.sh /root/zugfinder/crawler_yield_guard.sh && chmod +x /root/zugfinder/crawler_yield_guard.sh
```

校验两边一致（应输出相同 md5）：

```bash
md5sum deploy/*.sh /root/start_stops.sh /root/zugfinder/crawler_*.sh
```

> 尚未改为软链：调用链用绝对路径硬编码，改软链会动到运行中的部署拓扑，风险大于收益。
> 待部署脚本重构时再考虑"仓库副本 = 唯一真相"。

## 相关代码（仓库内）

- `server.js` —— `/api/debug` 端点：暴露 worker `/health`、行程车道、在途/最近行程腿。
- `public/app.js` —— 逐段进度「已完成 X/total」+ 右下角后端实时状态面板（轮询 `/api/debug`）。
- `predictor_worker.py` —— 预测 worker（5099，`PREDICTOR_MAX_CONCURRENCY=1`）。
