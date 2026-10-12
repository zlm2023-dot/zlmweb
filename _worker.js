/**
 * zlmweb.pages.dev 高级模式 Worker（D1 数据库版）
 * - /api/*  → Cloudflare D1 数据库读写（无需外部服务器）
 * - 其余路径 → 静态文件（问卷页）
 * 数据表首次访问自动创建。
 */
/* ---------- 计分与预警（与原服务器版完全一致） ---------- */
function gradePHQ(s) {
  if (s <= 9) return '无抑郁倾向';
  if (s <= 14) return '中度抑郁倾向';
  return '重度抑郁倾向';
}
function gradeGAD(s) {
  if (s <= 4) return '无焦虑';
  if (s <= 9) return '轻度焦虑';
  if (s <= 14) return '中度焦虑';
  return '重度焦虑';
}
function gradeSWLS(s) {
  if (s <= 19) return '对生活不满意';
  if (s === 20) return '中性';
  return '对生活满意';
}
function judgeAlert(phq, gad, swls) {
  const cond1 = swls >= 5 && swls <= 19;
  const cond2 = gad >= 10 && gad <= 21 && phq >= 10 && phq <= 27;
  if (!(cond1 && cond2)) return 0;
  if (gad >= 15 && phq >= 15) return 1;
  if ((gad >= 10 && gad <= 14 && phq >= 15) || (gad >= 15 && gad <= 21 && phq >= 10 && phq <= 14)) return 2;
  return 3;
}
function validArr(v, n, min, max) {
  return Array.isArray(v) && v.length === n &&
    v.every(x => Number.isInteger(x) && x >= min && x <= max);
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
}

/* ---------- 数据表（懒创建） ---------- */
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.prepare(
      `CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        school TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL
      )`
    ).run();
  }
  return schemaReady;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function readBody(request) {
  try { return await request.json(); }
  catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!db) {
      return json({ ok: false, msg: '数据库未绑定：请在 Pages 项目设置里添加名为 DB 的 D1 绑定' }, 500);
    }

    /* ---------- 健康检查 ---------- */
    if (url.pathname === '/api/health' && request.method === 'GET') {
      try {
        await ensureSchema(db);
        return json({ ok: true, time: Date.now() });
      } catch (e) {
        return json({ ok: false, msg: String(e && e.message || e) }, 500);
      }
    }

    if (request.method !== 'POST') {
      return json({ ok: false, msg: '方法不允许' }, 405);
    }

    const body = await readBody(request);

    try {
      await ensureSchema(db);

      /* ---------- 提交答卷 ---------- */
      if (url.pathname === '/api/submit') {
        const r = body && body.record;
        if (!r || typeof r.school !== 'string' || !r.school.trim() ||
            typeof r.name !== 'string' || !r.name.trim()) {
          return json({ ok: false, msg: '请填写学校与姓名' });
        }
        if (!validArr(r.phq9, 9, 0, 3) || !validArr(r.gad7, 7, 0, 3) || !validArr(r.swls, 5, 1, 7)) {
          return json({ ok: false, msg: '答卷数据不完整或格式错误' });
        }
        const phq = r.phq9.reduce((a, b) => a + b, 0);
        const gad = r.gad7.reduce((a, b) => a + b, 0);
        const swlsScore = r.swls.reduce((a, b) => a + b, 0);
        const rec = {
          _id: genId(),
          createdAt: Date.now(),
          school: r.school.trim().slice(0, 100),
          name: r.name.trim().slice(0, 50),
          phq9: r.phq9,
          gad7: r.gad7,
          swls: r.swls,
          phq, gad, swlsScore,
          phqLevel: gradePHQ(phq),
          gadLevel: gradeGAD(gad),
          swlsLevel: gradeSWLS(swlsScore),
          alertLevel: judgeAlert(phq, gad, swlsScore),
          selfHarm: r.phq9[8] > 0
        };
        await db.prepare('INSERT INTO records (id, created_at, school, data) VALUES (?1, ?2, ?3, ?4)')
          .bind(rec._id, rec.createdAt, rec.school.toLowerCase(), JSON.stringify(rec))
          .run();
        return json({ ok: true, id: rec._id });
      }

      /* ---------- 管理员：密码校验 ---------- */
      const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'zlm2026';
      if (!body || body.password !== ADMIN_PASSWORD) {
        return json({ ok: false, msg: '密码错误' });
      }

      if (url.pathname === '/api/list') {
        const school = String((body && body.school) || '').trim().toLowerCase();
        let stmt, rows;
        if (school) {
          stmt = db.prepare("SELECT data FROM records WHERE school LIKE ?1 ORDER BY created_at DESC LIMIT 1000");
          rows = await stmt.bind('%' + school + '%').all();
        } else {
          stmt = db.prepare("SELECT data FROM records ORDER BY created_at DESC LIMIT 1000");
          rows = await stmt.all();
        }
        const data = (rows.results || []).map(x => {
          try { return JSON.parse(x.data); } catch (e) { return null; }
        }).filter(Boolean);
        return json({ ok: true, data });
      }

      if (url.pathname === '/api/remove') {
        const id = body && body.id;
        if (!id) return json({ ok: false, msg: '缺少记录 ID' });
        await db.prepare('DELETE FROM records WHERE id = ?1').bind(id).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/clear') {
        await db.prepare('DELETE FROM records').run();
        return json({ ok: true });
      }

      return json({ ok: false, msg: '未知操作' }, 404);
    } catch (e) {
      return json({ ok: false, msg: '服务器内部错误：' + String(e && e.message || e) }, 500);
    }
  }
};
