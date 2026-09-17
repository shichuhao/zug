// verify_typectx.js —— 服务进程外验证 zfByType 加载与车型匹配逻辑
const path = require("path");
const fs = require("fs");
const ROOT = "/root/traindelay";

function readJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { return dflt; }
}

const byType = readJSON(path.join(ROOT, "data", "reasons", "zugfinder", "reason_by_type.json"), null);
console.log("zfByType 加载:", !!byType);
if (byType) {
  console.log("  车型:", Object.keys(byType.types || {}));
  const re = byType.types.RE;
  console.log("  RE.base:", JSON.stringify(re.base));
  console.log("  RE.strecke:", JSON.stringify(re.categories.strecke));
}

const zf = readJSON(path.join(ROOT, "data", "reasons", "zugfinder", "reason_stats.json"), null);
console.log("");
console.log("zfReasons 加载:", !!zf, "| categories:", (zf && zf.categories || []).length);

console.log("");
console.log("车次 -> 车型匹配:");
for (const ref of ["RE_49127", "ICE_847", "RB_25450", "FLX_1"]) {
  const m = /^([A-Z]{1,5})_/.exec(ref.toUpperCase());
  const t = m ? m[1] : null;
  const has = !!(t && byType && byType.types && byType.types[t]);
  console.log("  " + ref + " -> type=" + t + " 车型数据=" + (has ? "有" : "无"));
}
