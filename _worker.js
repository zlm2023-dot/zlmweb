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
function gradePHQ(s, cfg) {
  const c = cfg || DEFAULT_ALERT_CONFIG;
  if (s <= c.phqModerate) return '无抑郁倾向';
  if (s <= c.phqSevere) return '中度抑郁倾向';
  return '重度抑郁倾向';
}
function gradeGAD(s, cfg) {
  const c = cfg || DEFAULT_ALERT_CONFIG;
  if (s <= c.gadMild) return '无焦虑';
  if (s <= c.gadModerate) return '轻度焦虑';
  if (s <= c.gadSevere) return '中度焦虑';
  return '重度焦虑';
}
function gradeSWLS(s, cfg) {
  const c = cfg || DEFAULT_ALERT_CONFIG;
  if (s <= c.swlsLow) return '对生活不满意';
  if (s <= c.swlsNeutral) return '中性';
  return '对生活满意';
}
/* ==========================================================
   预警判定（阈值全部由 cfg 提供，教育局可在后台调整）
   默认 cfg 等价于原有固定口径：
     ① 生活满意度 5–19；② 焦虑 10–21 且 抑郁 10–27
     一级：焦虑 ≥15 且 抑郁 ≥15
     二级：焦虑低档 + 抑郁高档，或 焦虑高档 + 抑郁低档
     三级：其余
   ========================================================== */
function judgeAlert(phq, gad, swls, cfg) {
  const c = cfg || DEFAULT_ALERT_CONFIG;
  const cond1 = swls >= c.swlsMin && swls <= c.swlsMax;
  const cond2 = gad >= c.gadMin && gad <= c.gadMax && phq >= c.phqMin && phq <= c.phqMax;
  if (!(cond1 && cond2)) return 0;
  const gHi = gad >= c.gadHigh, pHi = phq >= c.phqHigh;
  const gLo = gad < c.gadHigh, pLo = phq < c.phqHigh;
  if (gHi && pHi) return 1;                 // 双高 → 一级
  if ((gLo && pHi) || (gHi && pLo)) return 2; // 一高一低 → 二级
  return 3;                                  // 其余 → 三级
}
function validArr(v, n, min, max) {
  return Array.isArray(v) && v.length === n &&
    v.every(x => Number.isInteger(x) && x >= min && x <= max);
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
}

/* ==========================================================
   默认预警判定参数（教育局可在后台调整，存于 alert_config 表）
   ========================================================== */
const DEFAULT_ALERT_CONFIG = {
  /* --- 等级分级阈值（分数 → 无/轻/中/重） --- */
  phqModerate: 9, phqSevere: 14,           // 抑郁：≤9 无，≤14 中度，其余重度
  gadMild: 4, gadModerate: 9, gadSevere: 14, // 焦虑：≤4 无，≤9 轻度，≤14 中度，其余重度
  swlsLow: 19, swlsNeutral: 20,            // 满意度：≤19 不满意，≤20 中性，其余满意
  /* --- 预警筛查区间 --- */
  swlsMin: 5, swlsMax: 19,     // 第一步筛查：生活满意度区间
  gadMin: 10, gadMax: 21,      // 第二步：焦虑区间
  phqMin: 10, phqMax: 27,      // 第二步：抑郁区间
  gadHigh: 15, phqHigh: 15     // 分级分界：≥ 视为「高」
};

/* ==========================================================
   量表定义（三套标准量表 + 教育局导入的自定义量表）
   opt: 4 → 0–3 四级频度（PHQ/GAD）；7 → 1–7 七级同意度（SWLS）
   base: 标准题数，题目数与之不符时按比例折算
   ========================================================== */
const STANDARD_SCALES = [
  {
    key: 'phq9', short: 'PHQ-9', name: '抑郁', base: 9, opt: 4, ord: 0, standard: 1,
    intro: '在最近两周中，你有多少天出现过以下情况？请根据你的实际情况，选出最符合你的选项。',
    items: [
      '做事时提不起劲或没有兴趣。',
      '感到心情低落、沮丧或绝望。',
      '入睡困难、睡不安稳或睡眠过多。',
      '感觉疲倦或没有活力。',
      '食欲不振或吃太多。',
      '觉得自己很糟，或觉得自己是失败者，或让自己或家人失望。',
      '对事物专注有困难，例如阅读报纸或看电视时。',
      '动作或说话速度缓慢到别人已经察觉？或正好相反——烦躁坐立不安、动来动去的情况更胜于平常。',
      '有不如死掉或用某种方式伤害自己的念头。'
    ]
  },
  {
    key: 'gad7', short: 'GAD-7', name: '焦虑', base: 7, opt: 4, ord: 1, standard: 1,
    intro: '在最近两周中，你有多少天出现过以下情况？请你根据实际情况，选出最符合的选项。',
    items: [
      '感觉紧张、焦虑或急切。',
      '不能停止或控制担忧。',
      '对各种各样的事情担忧过多。',
      '很难放松下来。',
      '由于不安而无法静坐。',
      '变得容易烦恼或急躁。',
      '感到似乎将有可怕的事情发生而害怕。'
    ]
  },
  {
    key: 'swls', short: 'SWLS', name: '生活满意度', base: 5, opt: 7, ord: 2, standard: 1,
    intro: '仔细阅读下列描述，它们与你现在的实际情况符合程度如何？请选择相应的选项。',
    items: [
      '在大多数情况下，我的生活接近我的理想状态。',
      '我的生活条件很好。',
      '我对我的生活感到满意。',
      '目前为止，我已经得到了生活中我想要的一些重要东西。',
      '如果可以再活一次，我还愿意过现在这样的生活。'
    ]
  }
];
const STANDARD_KEYS = STANDARD_SCALES.map(s => s.key);
/* 各量表「标准题数」，用于题目数与标准不符时折算回原分制 */
const BASE_COUNT = { phq9: 9, gad7: 7, swls: 5 };
/* 自杀意念题：PHQ-9 第 9 题，打上标记后即便题号变动也能定位 */
const SELFHARM_INDEX_DEFAULT = 8;

/* 得分折算：n 题时按 n → base 的比例还原到原量表分制 */
function prorate(sum, n, base) {
  if (!n) return 0;
  return Math.round(sum * base / n);
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
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,
          scale_key TEXT NOT NULL,
          title TEXT NOT NULL,
          ord INTEGER NOT NULL,
          flag TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        )`
      ).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_questions_scale ON questions(scale_key)').run();
      /* 量表定义表：三套标准量表 + 教育局导入的自定义量表 */
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS scales (
          id TEXT PRIMARY KEY,
          skey TEXT NOT NULL UNIQUE,
          short TEXT NOT NULL,
          name TEXT NOT NULL,
          base INTEGER NOT NULL DEFAULT 0,
          opt INTEGER NOT NULL DEFAULT 4,
          intro TEXT NOT NULL DEFAULT '',
          ord INTEGER NOT NULL DEFAULT 0,
          standard INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )`
      ).run();
      // 首次运行时，用环境变量里的管理员密码创建一个教育局账号
      const n = await db.prepare('SELECT COUNT(*) AS c FROM accounts').first();
      if (!n || n.c === 0) {
        const salt = randHex(16);
        const hash = await hashPassword(adminPwd || 'zlm2026', salt);
        await db.prepare(
          'INSERT INTO accounts (id,role,school,username,pass_hash,salt,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,1,?7)'
        ).bind(genId(), 'bureau', '', 'admin', hash, salt, Date.now()).run();
      }
      /* 量表表为空时，写入三套标准量表及其题目 */
      const sc = await db.prepare('SELECT COUNT(*) AS c FROM scales').first();
      if (!sc || sc.c === 0) {
        for (const s of STANDARD_SCALES) {
          await db.prepare(
            'INSERT INTO scales (id,skey,short,name,base,opt,intro,ord,standard,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,1,?9)'
          ).bind(genId(), s.key, s.short, s.name, s.base, s.opt, s.intro, s.ord, Date.now()).run();
          for (let i = 0; i < s.items.length; i++) {
            const flag = (s.key === 'phq9' && i === SELFHARM_INDEX_DEFAULT) ? 'selfharm' : '';
            await db.prepare(
              'INSERT INTO questions (id,scale_key,title,ord,flag,created_at) VALUES (?1,?2,?3,?4,?5,?6)'
            ).bind(genId(), s.key, s.items[i], i, flag, Date.now()).run();
          }
        }
      }
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS alert_config (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_by TEXT NOT NULL DEFAULT ''
        )`
      ).run();
      const ac = await db.prepare('SELECT COUNT(*) AS c FROM alert_config').first();
      if (!ac || ac.c === 0) {
        await db.prepare('INSERT INTO alert_config (id,data,updated_at,updated_by) VALUES (?1,?2,?3,?4)')
          .bind('default', JSON.stringify(DEFAULT_ALERT_CONFIG), Date.now(), 'system').run();
      }
    })();
  }
  return schemaReady;
}

/* 读取预警判定参数；缺失或非法字段自动回落到默认值 */
async function getAlertConfig(db) {
  const row = await db.prepare('SELECT data FROM alert_config WHERE id = ?1').bind('default').first();
  let c = {};
  try { c = JSON.parse(row && row.data || '{}') || {}; } catch (e) { c = {}; }
  const out = {};
  Object.keys(DEFAULT_ALERT_CONFIG).forEach(function (k) {
    const v = Number(c[k]);
    out[k] = isFinite(v) ? v : DEFAULT_ALERT_CONFIG[k];
  });
  return out;
}
async function saveAlertConfig(db, cfg, who) {
  const out = {};
  Object.keys(DEFAULT_ALERT_CONFIG).forEach(function (k) {
    const v = Number(cfg && cfg[k]);
    out[k] = isFinite(v) ? v : DEFAULT_ALERT_CONFIG[k];
  });
  await db.prepare('UPDATE alert_config SET data=?1, updated_at=?2, updated_by=?3 WHERE id=?4')
    .bind(JSON.stringify(out), Date.now(), who || '', 'default').run();
  return out;
}

/* 读取当前启用的量表定义（按 ord 排序）；标准量表排在前 */
async function getScales(db) {
  const rows = await db.prepare(
    'SELECT id,skey,short,name,base,opt,intro,ord,standard,enabled FROM scales WHERE enabled=1 ORDER BY ord, created_at'
  ).all();
  return (rows.results || []).map(function (r) {
    return {
      id: r.id, key: r.skey, short: r.short, name: r.name,
      base: r.base, opt: r.opt, intro: r.intro,
      ord: r.ord, standard: !!r.standard
    };
  });
}
/* 读取当前题库：按量表分组、按 ord 排序 */
async function getQuestions(db) {
  const rows = await db.prepare('SELECT id,scale_key,title,ord,flag FROM questions ORDER BY ord, created_at').all();
  const out = {};
  (rows.results || []).forEach(function (r) {
    (out[r.scale_key] = out[r.scale_key] || []).push(r);
  });
  return out;
}
/* 把某套标准量表恢复成默认题目（自定义量表不可调用） */
async function resetQuestions(db, key) {
  const s = STANDARD_SCALES.filter(function (x) { return x.key === key; })[0];
  if (!s) return false;
  await db.prepare('DELETE FROM questions WHERE scale_key = ?1').bind(key).run();
  for (let i = 0; i < s.items.length; i++) {
    const flag = (key === 'phq9' && i === SELFHARM_INDEX_DEFAULT) ? 'selfharm' : '';
    await db.prepare('INSERT INTO questions (id,scale_key,title,ord,flag,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(genId(), key, s.items[i], i, flag, Date.now()).run();
  }
  await db.prepare('UPDATE scales SET base=?1, intro=?2, name=?3, short=?4 WHERE skey=?5')
    .bind(s.base, s.intro, s.name, s.short, key).run();
  return true;
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

    /* ---------- GET：公开配置（量表 + 题库 + 预警参数，学生端与前端展示共用） ---------- */
    if (url.pathname === '/api/config' && request.method === 'GET') {
      const S = await getScales(db);
      const Q = await getQuestions(db);
      const scales = S.map(function (s) {
        return {
          key: s.key, short: s.short, name: s.name, base: s.base,
          opt: s.opt, intro: s.intro, standard: s.standard,
          items: (Q[s.key] || []).map(function (x) { return { id: x.id, title: x.title, flag: x.flag }; })
        };
      });
      const cfg = await getAlertConfig(db);
      return json({ ok: true, scales: scales, alert: cfg });
    }

    /* ---------- GET：公开题库（兼容旧调用：按量表分组返回题目） ---------- */
    if (url.pathname === '/api/questions' && request.method === 'GET') {
      const Q = await getQuestions(db);
      const data = {};
      Object.keys(Q).forEach(function (k) {
        data[k] = Q[k].map(function (x) { return { id: x.id, title: x.title, flag: x.flag }; });
      });
      return json({ ok: true, data });
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
        if (typeof r.grade !== 'string' || !r.grade.trim() ||
            typeof r.klass !== 'string' || !r.klass.trim()) {
          return json({ ok: false, msg: '请选择年级与班级' });
        }
        /* 题目数量以当前题库为准（教育局导入量表后自动生效） */
        const S = await getScales(db);
        const Q = await getQuestions(db);
        const ans = r.answers || {};
        /* 逐套量表校验：题数必须与当前题库一致，分值须落在该量表选项范围内 */
        const qcount = {}, qtext = {}, rawSum = {}, answers = {};
        for (const s of S) {
          const arr = ans[s.key];
          const qs = Q[s.key] || [];
          if (!qs.length) return json({ ok: false, msg: '量表「' + s.name + '」尚未配置题目，请联系教育局' });
          const lo = s.opt === 7 ? 1 : 0, hi = s.opt === 7 ? 7 : 3;
          if (!validArr(arr, qs.length, lo, hi)) {
            return json({ ok: false, msg: '答卷数据不完整或格式错误（' + s.short + ' 应为 ' + qs.length + ' 题）' });
          }
          answers[s.key] = arr.slice();
          qcount[s.key] = qs.length;
          qtext[s.key] = qs.map(function (x) { return x.title; });
          rawSum[s.key] = arr.reduce((a, b) => a + b, 0);
        }
        /* 三套标准量表必须存在，否则无法做预警判定 */
        const nP = qcount.phq9 || 0, nG = qcount.gad7 || 0, nS = qcount.swls || 0;
        if (!nP || !nG || !nS) return json({ ok: false, msg: '标准量表缺失，请联系教育局配置' });
        /* 后端重新计分，不信任前端传来的分数 */
        const phqRaw = rawSum.phq9, gadRaw = rawSum.gad7, swlsRaw = rawSum.swls;
        /* 题目数与标准不符时，按比例折算回原量表分制，保证仍能套用阈值 */
        const phq = prorate(phqRaw, nP, BASE_COUNT.phq9);
        const gad = prorate(gadRaw, nG, BASE_COUNT.gad7);
        const swlsScore = prorate(swlsRaw, nS, BASE_COUNT.swls);
        const alertCfg = await getAlertConfig(db);
        /* 自杀意念题按 flag 定位，题号变动也不会跟丢 */
        const shIdx = (Q.phq9 || []).findIndex(function (q) { return q.flag === 'selfharm'; });
        const shv = shIdx >= 0 ? answers.phq9[shIdx] : 0;
        /* 自定义量表：单独记分，不参与预警算法 */
        const extra = {};
        S.forEach(function (s) {
          if (s.standard) return;
          extra[s.key] = { name: s.name, short: s.short, raw: rawSum[s.key], n: qcount[s.key] };
        });
        const rec = {
          _id: genId(),
          createdAt: Date.now(),
          school: r.school.trim().slice(0, 100),
          name: r.name.trim().slice(0, 50),
          grade: r.grade.trim().slice(0, 30),
          klass: r.klass.trim().slice(0, 30),
          /* 兼容旧字段命名 */
          phq9: answers.phq9, gad7: answers.gad7, swls: answers.swls,
          answers, extra,
          phqRaw, gadRaw, swlsRaw, rawSum,
          phq, gad, swlsScore,
          phqLevel: gradePHQ(phq, alertCfg),
          gadLevel: gradeGAD(gad, alertCfg),
          swlsLevel: gradeSWLS(swlsScore, alertCfg),
          alertLevel: judgeAlert(phq, gad, swlsScore, alertCfg),
          hasSelfHarmQ: shIdx >= 0,
          selfHarm: shv > 0,
          selfHarmScore: shv,          /* 自杀意念维度：该题原始得分 0–3 */
          qcount,
          scaleNames: S.map(function (s) { return { key: s.key, name: s.name, short: s.short, standard: s.standard }; }),
          qtext                        /* 题目快照：历史答卷按当时题面展示，不受后续导入影响 */
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
          /* 入库时校名统一转成小写，这里也要同样处理，否则中文/大小写差异会删不掉 */
          await db.prepare('DELETE FROM records WHERE school = ?1').bind(normSchool(me.school)).run();
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

      /* ==========================================================
         教育局端：量表管理（整体导入 / 替换 / 删除）
         不再支持单题增删——整表导入才能保证量表内部一致、可复核
         ========================================================== */
      if (url.pathname === '/api/scales/import') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });

        const key = String(body.key || '').trim();
        const name = String(body.name || '').trim();
        const short = String(body.short || '').trim() || name;
        const intro = String(body.intro || '').trim();
        const opt = Number(body.opt) === 7 ? 7 : 4;
        const items = Array.isArray(body.items) ? body.items : [];

        if (!key) return json({ ok: false, msg: '缺少量表标识' });
        if (!name) return json({ ok: false, msg: '请填写量表名称' });
        if (!items.length) return json({ ok: false, msg: '请至少导入 1 道题目' });
        if (items.length > 100) return json({ ok: false, msg: '题目过多（最多 100 题）' });
        if (name.length > 40) return json({ ok: false, msg: '量表名称过长（最多 40 字）' });
        if (intro.length > 300) return json({ ok: false, msg: '指导语过长（最多 300 字）' });

        /* 清洗题目：去空白行、去行首编号、截断超长 */
        const clean = [];
        for (const raw of items) {
          const t = String(raw == null ? '' : raw)
            .replace(/^\s*\d+[\.、\)）]\s*/, '')   // 去掉「1. 」「2、」这类前缀
            .trim();
          if (!t) continue;
          if (t.length > 200) return json({ ok: false, msg: '有题目超过 200 字，请精简后再导入' });
          clean.push(t);
        }
        if (!clean.length) return json({ ok: false, msg: '没有识别到有效题目' });

        const isStd = STANDARD_KEYS.indexOf(key) >= 0;
        const row = await db.prepare('SELECT id,standard FROM scales WHERE skey = ?1').bind(key).first();

        if (row && row.standard) {
          /* 标准量表：只允许整体替换题目与指导语，名称/选项类型锁定 */
          const std = STANDARD_SCALES.filter(x => x.key === key)[0];
          await db.prepare('DELETE FROM questions WHERE scale_key = ?1').bind(key).run();
          for (let i = 0; i < clean.length; i++) {
            const flag = (key === 'phq9' && i === SELFHARM_INDEX_DEFAULT) ? 'selfharm' : '';
            await db.prepare('INSERT INTO questions (id,scale_key,title,ord,flag,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
              .bind(genId(), key, clean[i], i, flag, Date.now()).run();
          }
          await db.prepare('UPDATE scales SET intro=?1 WHERE skey=?2').bind(intro || std.intro, key).run();
          return json({ ok: true, replaced: true });
        }

        if (row) {
          /* 已存在的自定义量表：整体替换 */
          await db.prepare('DELETE FROM questions WHERE scale_key = ?1').bind(key).run();
          for (let i = 0; i < clean.length; i++) {
            await db.prepare('INSERT INTO questions (id,scale_key,title,ord,flag,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
              .bind(genId(), key, clean[i], i, '', Date.now()).run();
          }
          await db.prepare('UPDATE scales SET short=?1, name=?2, opt=?3, intro=?4, base=?5 WHERE skey=?6')
            .bind(short, name, opt, intro, clean.length, key).run();
          return json({ ok: true, replaced: true });
        }

        /* 新建自定义量表 */
        const mx = await db.prepare('SELECT MAX(ord) AS m FROM scales').first();
        const ord = (mx && typeof mx.m === 'number') ? mx.m + 1 : STANDARD_SCALES.length;
        await db.prepare(
          'INSERT INTO scales (id,skey,short,name,base,opt,intro,ord,standard,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,1,?9)'
        ).bind(genId(), key, short, name, clean.length, opt, intro, ord, Date.now()).run();
        for (let i = 0; i < clean.length; i++) {
          await db.prepare('INSERT INTO questions (id,scale_key,title,ord,flag,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
            .bind(genId(), key, clean[i], i, '', Date.now()).run();
        }
        return json({ ok: true, created: true });
      }

      /* 恢复某套标准量表为出厂题目 */
      if (url.pathname === '/api/scales/reset') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const key = String(body.key || '');
        if (STANDARD_KEYS.indexOf(key) < 0) return json({ ok: false, msg: '只能恢复标准量表' });
        const done = await resetQuestions(db, key);
        if (!done) return json({ ok: false, msg: '量表不存在' });
        return json({ ok: true });
      }

      /* 删除自定义量表（标准量表不可删） */
      if (url.pathname === '/api/scales/delete') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const key = String(body.key || '');
        const row = await db.prepare('SELECT id,standard FROM scales WHERE skey = ?1').bind(key).first();
        if (!row) return json({ ok: false, msg: '量表不存在' });
        if (row.standard) return json({ ok: false, msg: '标准量表不可删除' });
        await db.prepare('DELETE FROM questions WHERE scale_key = ?1').bind(key).run();
        await db.prepare('DELETE FROM scales WHERE skey = ?1').bind(key).run();
        return json({ ok: true });
      }

      /* ----- 教育局端：预警判定参数 ----- */
      if (url.pathname === '/api/alert/get') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const row = await db.prepare('SELECT data,updated_at,updated_by FROM alert_config WHERE id=?1').bind('default').first();
        return json({ ok: true, config: await getAlertConfig(db),
          updatedAt: (row && row.updated_at) || 0, updatedBy: (row && row.updated_by) || '' });
      }

      if (url.pathname === '/api/alert/save') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const c = body.config || {};
        /* 所有可调参数统一取数字；缺失或非法一律报错，避免存进半套配置 */
        const vals = {};
        for (const k of Object.keys(DEFAULT_ALERT_CONFIG)) {
          const n = Number(c[k]);
          if (!isFinite(n)) return json({ ok: false, msg: '参数「' + k + '」不是有效数字' });
          vals[k] = n;
        }
        /* --- 区间合法性 --- */
        if (vals.swlsMin > vals.swlsMax) return json({ ok: false, msg: '生活满意度：最小值不能大于最大值' });
        if (vals.gadMin > vals.gadMax)   return json({ ok: false, msg: '焦虑：最小值不能大于最大值' });
        if (vals.phqMin > vals.phqMax)   return json({ ok: false, msg: '抑郁：最小值不能大于最大值' });
        if (vals.gadHigh < vals.gadMin || vals.gadHigh > vals.gadMax + 1)
          return json({ ok: false, msg: '焦虑分级分界值须落在焦虑区间内' });
        if (vals.phqHigh < vals.phqMin || vals.phqHigh > vals.phqMax + 1)
          return json({ ok: false, msg: '抑郁分级分界值须落在抑郁区间内' });
        /* --- 分级阈值需递增，且落在该量表满分范围内 --- */
        if (vals.phqModerate >= vals.phqSevere) return json({ ok: false, msg: '抑郁：中度阈值须小于重度阈值' });
        if (vals.gadMild >= vals.gadModerate || vals.gadModerate >= vals.gadSevere)
          return json({ ok: false, msg: '焦虑：无/轻/中/重 阈值须依次递增' });
        if (vals.swlsLow >= vals.swlsNeutral) return json({ ok: false, msg: '生活满意度：不满意阈值须小于中性阈值' });
        const saved = await saveAlertConfig(db, vals, me.username);
        return json({ ok: true, config: saved });
      }

      /* 按当前参数重算全部历史答卷：改了阈值后，老数据也能用新口径重新分级 */
      if (url.pathname === '/api/alert/recalc') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const cfg = await getAlertConfig(db);
        const rows = await db.prepare('SELECT id, data FROM records').all();
        let n = 0;
        for (const row of (rows.results || [])) {
          let rec;
          try { rec = JSON.parse(row.data); } catch (e) { continue; }
          if (!rec) continue;
          /* 用记录里存的原始作答重算；题数取自作答数组本身（兼容早期无 qcount 的记录） */
          const p = Array.isArray(rec.phq9) ? rec.phq9 : [];
          const g = Array.isArray(rec.gad7) ? rec.gad7 : [];
          const s = Array.isArray(rec.swls) ? rec.swls : [];
          if (!p.length || !g.length || !s.length) continue;
          const phq = prorate(p.reduce((a, b) => a + b, 0), p.length, BASE_COUNT.phq9);
          const gad = prorate(g.reduce((a, b) => a + b, 0), g.length, BASE_COUNT.gad7);
          const swlsScore = prorate(s.reduce((a, b) => a + b, 0), s.length, BASE_COUNT.swls);
          rec.phqRaw = p.reduce((a, b) => a + b, 0);
          rec.gadRaw = g.reduce((a, b) => a + b, 0);
          rec.swlsRaw = s.reduce((a, b) => a + b, 0);
          rec.phq = phq; rec.gad = gad; rec.swlsScore = swlsScore;
          rec.phqLevel = gradePHQ(phq, cfg);
          rec.gadLevel = gradeGAD(gad, cfg);
          rec.swlsLevel = gradeSWLS(swlsScore, cfg);
          rec.alertLevel = judgeAlert(phq, gad, swlsScore, cfg);
          await db.prepare('UPDATE records SET data = ?1 WHERE id = ?2')
            .bind(JSON.stringify(rec), row.id).run();
          n++;
        }
        return json({ ok: true, count: n });
      }

      if (url.pathname === '/api/alert/reset') {
        const bad = needBureau(me);
        if (bad) return json({ ok: false, msg: bad });
        const saved = await saveAlertConfig(db, DEFAULT_ALERT_CONFIG, me.username);
        return json({ ok: true, config: saved });
      }

      return json({ ok: false, msg: '未知操作' }, 404);
    } catch (e) {
      return json({ ok: false, msg: '服务器内部错误：' + String(e && e.message || e) }, 500);
    }
  }
};
