/* 桩 Worker：用于验证 server.js 的 worker 分支处理，完全不动真实 python。
   Node 只 POST /predict 且不带 query，所以用 POST body 里的 train 前缀驱动行为：
     STUB_BIZERR_* → 502 + {"error":...}  （worker 判定业务错误的真实形态）
     STUB_BUSY_*   → 503 + worker_busy    （并发闸门满）
     STUB_SLOW_*   → 200 但延迟 2s        （测并发合并 / 失败广播）
     其余          → 200 + 合法预测体      （测正常穿过 finishPrediction） */
const http = require("http");
let inUse = 0;
const MAX_BUSY = 1; // 闸门设成 1，方便稳定重现 busy

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ready: true, in_use: inUse, max_concurrency: 99 }));
    }
    let params = {};
    try { params = JSON.parse(body || "{}"); } catch (_) {}
    const train = String(params.train || "");

    if (train.startsWith("STUB_BIZERR")) {
      await new Promise((r) => setTimeout(r, 200));
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "车次不存在或已停运" }));
    }
    if (train.startsWith("STUB_BUSY")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "worker_busy", max_concurrency: 0 }));
    }
    // 闸门：已有在途 → 503（用于检验 node 是否误降级 spawn）
    if (inUse >= MAX_BUSY && !train.startsWith("STUB_OK")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "worker_busy", max_concurrency: MAX_BUSY }));
    }
    inUse++;
    await new Promise((r) => setTimeout(r, train.startsWith("STUB_SLOW") ? 2000 : 100));
    inUse--;
    const now = new Date().toISOString();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      train, generated_at: now, query_date: "2026-09-15",
      prediction: { point_estimate: 3.2, p10: 0, p90: 9, prob_ge15: 0.05,
                    prob_ge30: 0.01, on_time_prob: 0.8, today_actual: null,
                    n_days: 8, mode: "end", destination: null },
      stations: [], cache_hit: false,
    }));
  });
});
server.listen(5098, () => console.log("stub worker on 5098"));
