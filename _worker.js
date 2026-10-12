/**
 * zlmweb.pages.dev 高级模式 Worker
 * - /api/*  → 反向代理到腾讯云轻量服务器（数据唯一存储点）
 * - 其余路径 → 返回静态文件（主页、/survey/ 问卷页）
 */
const ORIGIN = 'http://129.204.108.63';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const target = ORIGIN + url.pathname + url.search;
      const headers = new Headers();
      const ct = request.headers.get('Content-Type');
      if (ct) headers.set('Content-Type', ct);

      const init = { method: request.method, headers };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.text();
      }

      try {
        const resp = await fetch(target, init);
        const outHeaders = new Headers();
        outHeaders.set('Content-Type', resp.headers.get('Content-Type') || 'application/json; charset=utf-8');
        outHeaders.set('Cache-Control', 'no-store');
        return new Response(resp.body, { status: resp.status, headers: outHeaders });
      } catch (e) {
        return new Response(
          JSON.stringify({ ok: false, msg: '后台服务暂时不可用，请稍后再试' }),
          { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    }

    // 非 API 请求：返回静态资源
    return env.ASSETS.fetch(request);
  }
};
