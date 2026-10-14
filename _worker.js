/**
 * 心理健康测评平台 Worker（Cloudflare Pages 高级模式 + D1）
 * ------------------------------------------------------------
 * 三种使用者：
 *   1) 学生        —— 免账号：选学校 + 填姓名 → 答题（/api/submit 开放）
 *   2) 学校端      —— 账号登录，只能看「本校」学生
 *   3) 教育局端    —— 账号登录，可看「全部学校」，并可创建/管理学校账号
 *
 * 数据表首次访问自动创建：records / accounts / sessions
 */
/* ==========================================================
   一、计分与预警（与原服务器版完全一致，勿随意改动）
   ========================================================== */
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

/* ==========================================================
   二、密码加密与令牌
   ========================================================== */
/* PBKDF2 迭代次数：免费版 Cloudflare 若报 CPU 超限，可下调到 5000 */
const PBKDF2_ITER = 10000;
const SESSION_DAYS = 7;

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return bufToHex(a);
}
/* 密码 → 哈希（加盐，不可逆；数据库里绝不存明文密码） */
async function hashPassword(pw, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key, 256
  );
  return bufToHex(bits);
}
/* 学校名统一成小写去空格，保证「茂名一中」与「茂名市第一中学」不会因为写法不同而匹配不上 */
function normSchool(s) {
  return String(s || '').trim().toLowerCase();
}

/* ==========================================================
   三、数据表（懒创建）
   ========================================================== */
let schemaReady = null;
async function ensureSchema(db, adminPwd) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          school TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        )`
      ).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          school TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL UNIQUE,
          pass_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )`
      ).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          role TEXT NOT NULL,
          school TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`
      ).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_records_school ON records(school)').run();
      // 首次运行时，用环境变量里的管理员密码创建一个教育局账号
      const n = await db.prepare('SELECT COUNT(*) AS c FROM accounts').first();
      if (!n || n.c === 0) {
        const salt = randHex(16);
        const hash = await hashPassword(adminPwd || 'zlm2026', salt);
        await db.prepare(
          'INSERT INTO accounts (id,role,school,username,pass_hash,salt,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,1,?7)'
        ).bind(genId(), 'bureau', '', 'admin', hash, salt, Date.now()).run();
      }
    })();
  }
  return schemaReady;
}
/* ==========================================================
   四、通用工具
   ========================================================== */
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
/* 校验收到的 token，返回登录者身份；无效返回 null */
async function auth(db, token) {
  if (!token || typeof token !== 'string') return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token = ?1').bind(token).first();
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
    return null;
  }
  return { id: s.account_id, role: s.role, school: s.school, username: s.username, token: s.token };
}
/* 教育局端必须；学校端必须且只能操作本校 */
function needBureau(a) {
  return a && a.role === 'bureau' ? null : '仅教育局端可执行此操作';
}

/* ==========================================================
   五、主入口
   ========================================================== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;

    /* 非 /api 请求 → 静态页面 */
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    if (!db) {
      return json({ ok: false, msg: '数据库未绑定：请在 Pages 项目设置里添加名为 DB 的 D1 绑定' }, 500);
    }

    try {
      await ensureSchema(db, env.ADMIN_PASSWORD || 'zlm2026');
    } catch (e) {
      return json({ ok: false, msg: '数据表初始化失败：' + String(e && e.message || e) }, 500);
    }

    /* ---------- GET：健康检查 ---------- */
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, time: Date.now() });
    }

    /* ---------- GET：公开学校名单（学生选学校用，不含任何敏感信息） ---------- */
    if (url.pathname === '/api/schools/public' && request.method === 'GET') {
      const rows = await db.prepare(
        "SELECT school FROM accounts WHERE role='school' AND active=1 ORDER BY school"
      ).all();
      const names = (rows.results || []).map(x => x.school).filter(Boolean);
      return json({ ok: true, schools: names });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, msg: '方法不允许' }, 405);
    }

    const body = await readBody(request) || {};

    try {
      /* ==========================================================
         学生提交答卷（开放接口，无需登录）
         ========================================================== */
      if (url.pathname === '/api/submit') {
        const r = body.record;
        if (!r || typeof r.school !== 'string' || !r.school.trim() ||
            typeof r.name !== 'string' || !r.name.trim()) {
          return json({ ok: false, msg: '请填写学校与姓名' });
        }
        if (!validArr(r.phq9, 9, 0, 3) || !validArr(r.gad7, 7, 0, 3) || !validArr(r.swls, 5, 1, 7)) {
          return json({ ok: false, msg: '答卷数据不完整或格式错误' });
        }
        /* 后端重新计分，不信任前端传来的分数 */
        const phq = r.phq9.reduce((a, b) => a + b, 0);
        const gad = r.gad7.reduce((a, b) => a + b, 0);
        const swlsScore = r.swls.reduce((a, b) => a + b, 0);
        const rec = {
          _id: genId(),
          createdAt: Date.now(),
          school: r.school.trim().slice(0, 100),
          name: r.name.trim().slice(0, 50),
          phq9: r.phq9, gad7: r.gad7, swls: r.swls,
          phq, gad, swlsScore,
          phqLevel: gradePHQ(phq),
          gadLevel: gradeGAD(gad),
          swlsLevel: gradeSWLS(swlsScore),
          alertLevel: judgeAlert(phq, gad, swlsScore),
          selfHarm: r.phq9[8] > 0
        };
        await db.prepare('INSERT INTO records (id, created_at, school, data) VALUES (?1, ?2, ?3, ?4)')
          .bind(rec._id, rec.createdAt, normSchool(rec.school), JSON.stringify(rec))
          .run();
        return json({ ok: true, id: rec._id });
      }

      /* ==========================================================
         登录 / 登出 / 身份查询
         ========================================================== */
      if (url.pathname === '/api/login') {
        const u = String(body.username || '').trim().toLowerCase();
        const p = String(body.password || '');
        if (!u || !p) return json({ ok: false, msg: '请输入账号与密码' });
        const acc = await db.prepare('SELECT * FROM accounts WHERE username = ?1').bind(u).first();
        if (!acc) return json({ ok: false, msg: '账号或密码错误' });
        if (!acc.active) return json({ ok: false, msg: '该账号已被停用，请联系教育局' });
        const hash = await hashPassword(p, acc.salt);
        if (hash !== acc.pass_hash) return json({ ok: false, msg: '账号或密码错误' });

        const token = randHex(32);
        const now = Date.now();
        await db.prepare(
          'INSERT INTO sessions (token,account_id,role,school,username,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7)'
        ).bind(token, acc.id, acc.role, acc.school, acc.username, now, now + SESSION_DAYS * 864e5).run();
        return json({ ok: true, token, role: acc.role, school: acc.school, username: acc.username });
      }

      if (url.pathname === '/api/logout') {
        const a = await auth(db, body.token);
        if (a) await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(a.token).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/me') {
        const a = await auth(db, body.token);
        if (!a) return json({ ok: false, msg: '登录已失效，请重新登录' });
        return json({ ok: true, role: a.role, school: a.school, username: a.username });
      }

      if (url.pathname === '/api/pwd/change') {
        const a = await auth(db, body.token);
        if (!a) return json({ ok: false, msg: '登录已失效，请重新登录' });
        const oldP = String(body.oldPwd || ''), newP = String(body.newPwd || '');
        if (newP.length < 6) return json({ ok: false, msg: '新密码至少 6 位' });
        const acc = await db.prepare('SELECT * FROM accounts WHERE id = ?1').bind(a.id).first();
        if (!acc || (await hashPassword(oldP, acc.salt)) !== acc.pass_hash) {
          return json({ ok: false, msg: '原密码不正确' });
        }
        const salt = randHex(16);
        await db.prepare('UPDATE accounts SET pass_hash=?1, salt=?2 WHERE id=?3')
          .bind(await hashPassword(newP, salt), salt, acc.id).run();
        return json({ ok: true });
      }

      /* ==========================================================
         以下接口均需登录
         ========================================================== */
      const me = await auth(db, body.token);
      if (!me) return json({ ok: false, msg: '登录已失效，请重新登录' });

      /* ---------- 答卷列表：教育局看全部，学校只看本校 ---------- */
      if (url.pathname === '/api/list') {
        const kw = String(body.school || '').trim().toLowerCase();
        let rows;
        if (me.role === 'school') {
          rows = await db.prepare(
            'SELECT data FROM records WHERE school = ?1 ORDER BY created_at DESC LIMIT 2000'
          ).bind(me.school).all();
        } else if (kw) {
          rows = await db.prepare(
            'SELECT data FROM records WHERE school LIKE ?1 ORDER BY created_at DESC LIMIT 2000'
          ).bind('%' + kw + '%').all();
        } else {
          rows = await db.prepare(
            'SELECT data FROM records ORDER BY created_at DESC LIMIT 2000'
          ).all();
        }
        const data = (rows.results || []).map(x => {
          try { return JSON.parse(x.data); } catch (e) { return null; }
        }).filter(Boolean);
        /* 教育局端若传了关键字，结果里再精确过滤一次（前端即时筛选用） */
        const out = (me.role === 'bureau' && kw)
          ? data.filter(r => normSchool(r.school).indexOf(kw) >= 0)
          : data;
        return json({ ok: true, data: out });
      }

      if (url.pathname === '/api/remove') {
        const id = body.id;
        if (!id) return json({ ok: false, msg: '缺少记录 ID' });
        if (me.role === 'school') {
          const row = await db.prepare('SELECT school FROM records WHERE id = ?1').bind(id).first();
          if (!row) return json({ ok: false, msg: '记录不存在' });
          if (normSchool(row.school) !== me.school) return json({ ok: false, msg: '无权删除其他学校的数据' });
        }
        await db.prepare('DELETE FROM records WHERE id = ?1').bind(id).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/clear') {
        if (me.role === 'school') {
          await db.prepare('DELETE FROM records WHERE school = ?1').bind(me.school).run();
        } else {
          await db.prepare('DELETE FROM records').run();
        }
        return json({ ok: true });
      }

      /* ==========================================================
         教育局端：学校账号管理
         ========================================================== */
      if (url.pathname === '/api/schools/list') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const rows = await db.prepare(
          "SELECT id,school,username,active,created_at FROM accounts WHERE role='school' ORDER BY created_at DESC"
        ).all();
        return json({ ok: true, data: rows.results || [] });
      }

      if (url.pathname === '/api/schools/create') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const school = String(body.school || '').trim();
        const username = String(body.username || '').trim().toLowerCase();
        const pwd = String(body.password || '');
        if (!school) return json({ ok: false, msg: '请填写学校名称' });
        if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return json({ ok: false, msg: '登录账号需为 3–30 位字母/数字/-/_' });
        if (pwd.length < 6) return json({ ok: false, msg: '初始密码至少 6 位' });

        const dup = await db.prepare('SELECT id FROM accounts WHERE username = ?1').bind(username).first();
        if (dup) return json({ ok: false, msg: '该登录账号已存在' });
        const dupS = await db.prepare('SELECT id FROM accounts WHERE role=?1 AND school=?2')
          .bind('school', normSchool(school)).first();
        if (dupS) return json({ ok: false, msg: '该学校已开通过账号' });

        const salt = randHex(16);
        await db.prepare(
          'INSERT INTO accounts (id,role,school,username,pass_hash,salt,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,1,?7)'
        ).bind(genId(), 'school', normSchool(school), username, await hashPassword(pwd, salt), salt, Date.now()).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/schools/reset') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const pwd = String(body.password || '');
        if (pwd.length < 6) return json({ ok: false, msg: '新密码至少 6 位' });
        const acc = await db.prepare("SELECT id FROM accounts WHERE id=?1 AND role='school'").bind(body.id).first();
        if (!acc) return json({ ok: false, msg: '学校账号不存在' });
        const salt = randHex(16);
        await db.prepare('UPDATE accounts SET pass_hash=?1, salt=?2 WHERE id=?3')
          .bind(await hashPassword(pwd, salt), salt, acc.id).run();
        await db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(acc.id).run(); // 强制下线
        return json({ ok: true });
      }

      if (url.pathname === '/api/schools/toggle') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const acc = await db.prepare("SELECT id FROM accounts WHERE id=?1 AND role='school'").bind(body.id).first();
        if (!acc) return json({ ok: false, msg: '学校账号不存在' });
        await db.prepare('UPDATE accounts SET active=?1 WHERE id=?2').bind(body.active ? 1 : 0, acc.id).run();
        if (!body.active) await db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(acc.id).run();
        return json({ ok: true });
      }

      if (url.pathname === '/api/schools/delete') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const acc = await db.prepare("SELECT id,school FROM accounts WHERE id=?1 AND role='school'").bind(body.id).first();
        if (!acc) return json({ ok: false, msg: '学校账号不存在' });
        if (body.deleteData !== true) {
          // 默认只删账号，保留该校已提交的答卷
          await db.prepare('DELETE FROM accounts WHERE id = ?1').bind(acc.id).run();
          await db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(acc.id).run();
          return json({ ok: true });
        }
        await db.prepare('DELETE FROM records WHERE school = ?1').bind(acc.school).run();
        await db.prepare('DELETE FROM accounts WHERE id = ?1').bind(acc.id).run();
        await db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(acc.id).run();
        return json({ ok: true });
      }

      return json({ ok: false, msg: '未知操作' }, 404);
    } catch (e) {
      return json({ ok: false, msg: '服务器内部错误：' + String(e && e.message || e) }, 500);
    }
  }
};
