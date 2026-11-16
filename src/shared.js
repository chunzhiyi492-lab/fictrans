/* FicTrans 共享纯逻辑：Service Worker / 内容脚本 / 设置页 / 弹窗 共用。
 * 不依赖 DOM，可在 Node 下做单测。 */
(function (root) {
  'use strict';

  var RE_HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;
  var RE_HAN = /[一-鿿豈-﫿]/g;
  var RE_KANA = /[぀-ヿㇰ-ㇿ]/g;
  var RE_LATIN = /[A-Za-z]/g;

  function count(re, s) {
    var m = s.match(re);
    return m ? m.length : 0;
  }

  /** 判断一段文字的主语言：'ko' | 'en' | 'zh' | 'ja' | 'other' */
  function detectLang(text) {
    var hg = count(RE_HANGUL, text);
    var hn = count(RE_HAN, text);
    var kn = count(RE_KANA, text);
    if (hg >= 2 && hg >= hn * 0.5) return 'ko';
    if (kn >= 2 && kn >= hn - 0.5) return 'ja';
    if (hn >= 2) return 'zh';
    var lat = count(RE_LATIN, text);
    var words = text.split(/\s+/).filter(function (w) { return /[A-Za-z]/.test(w); }).length;
    if (lat >= 10 && words >= 2) return 'en';
    return 'other';
  }

  /** 是否值得翻译（韩文或英文）。返回 {ok, reason} */
  function shouldTranslateText(raw) {
    var t = (raw || '').replace(/ /g, ' ').trim();
    if (t.length < 2) return { ok: false, reason: 'too-short' };
    if (/^https?:\/\//i.test(t)) return { ok: false, reason: 'url' };
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return { ok: false, reason: 'email' };
    // 纯数字/符号
    if (!/[가-힣一-鿿぀-ヿA-Za-z]/.test(t)) return { ok: false, reason: 'no-letters' };
    // 类用户名 / @handle / 短代号（无空格、无韩文、无中文）
    if (!/[가-힣一-鿿぀-ヿ]/.test(t) && /^[A-Za-z0-9_.\-@]{1,24}$/.test(t)) return { ok: false, reason: 'handle' };
    var lang = detectLang(t);
    if (lang === 'ko' || lang === 'en') return { ok: true, lang: lang };
    return { ok: false, reason: 'lang-' + lang };
  }

  /** 过长段落切分（按空行 → 句号 → 硬切） */
  function splitLongText(text, maxLen) {
    maxLen = maxLen || 1200;
    if (text.length <= maxLen) return [text];
    var chunks = text.split(/\n\s*\n/);
    var out = [];
    chunks.forEach(function (c) {
      c = c.replace(/\s+$/,'');
      if (!c) return;
      if (c.length <= maxLen) { out.push(c); return; }
      var sents = c.split(/(?<=[.!?…。！？\n])/);
      var buf = '';
      sents.forEach(function (s) {
        if ((buf + s).length > maxLen && buf) { out.push(buf); buf = s; }
        else buf += s;
      });
      if (buf) out.push(buf);
    });
    // 兜底：单句仍超长则硬切
    var res = [];
    out.forEach(function (o) {
      while (o.length > maxLen) { res.push(o.slice(0, maxLen)); o = o.slice(maxLen); }
      if (o.trim()) res.push(o);
    });
    return res;
  }

  /** 从术语表中挑出与本批文本相关的条目（子串命中） */
  function pickGlossary(terms, batchText) {
    if (!Array.isArray(terms)) return [];
    var low = batchText.toLowerCase();
    var hit = [];
    terms.forEach(function (t) {
      if (!t || !t.source) return;
      if (low.indexOf(String(t.source).toLowerCase()) !== -1) hit.push(t);
    });
    return hit.slice(0, 60);
  }

  function tokenizeKorean(s) {
    return s.split(/[^가-힣a-zA-Z0-9]+/).filter(function (w) { return w.length >= 2; });
  }

  /** 从例句库挑与本批最相关的少数几条（置顶优先 + 词元重叠打分） */
  function pickExamples(examples, batchText, maxN) {
    maxN = maxN || 3;
    if (!Array.isArray(examples) || !examples.length) return [];
    var batchTokens = {};
    tokenizeKorean(batchText).forEach(function (w) { batchTokens[w.toLowerCase()] = true; });
    var scored = examples.map(function (ex) {
      var score = ex.pin ? 1000 : 0;
      tokenizeKorean(ex.src || '').forEach(function (w) {
        if (batchTokens[w.toLowerCase()]) score += 1;
      });
      return { ex: ex, score: score };
    }).filter(function (x) { return x.ex && x.ex.src && (x.score > 0); });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, maxN).map(function (x) { return x.ex; });
  }

  /** 组装系统提示词 */
  function buildSystemPrompt(opts) {
    opts = opts || {};
    var g = opts.glossary || [];
    var ex = opts.examples || [];
    var lines = [];
    lines.push('你是专业文学翻译，擅长韩国偶像同人志(웹진/팬픽)与同人社区(팬덤)语境的韩文→简体中文翻译，以及英文→简体中文翻译。');
    lines.push('');
    lines.push('任务：把用户给出的若干段落翻译为自然、流畅、符合网络小说阅读习惯的简体中文。');
    lines.push('');
    lines.push('要求：');
    lines.push('1. 忠实传达原意，保留原文语气、情绪、节奏与氛围；对话要像角色本人在说话。');
    lines.push('2. 正确处理韩语敬语/半语、称呼(오빠/형/누나/언니/너/님 등)、人物关系、CP 名、作品名、饭圈缩写与梗；不要直译导致人物关系错乱。');
    lines.push('3. 不要解释、不要写译注、不要补充原文没有的内容。遇到无法确定含义的圈内词时，保留原词并在其后用括号给出直译(例如 떡밥(伏笔/梗))，不要编造。');
    lines.push('4. 表情符号、专有名词、数字、URL 原样保留。');
    lines.push('5. 每个输入段落独立翻译，输出段落数必须与输入一一对应，不要合并、拆分或遗漏。');
    lines.push('');
    if (g.length) {
      lines.push('【用户术语表(必须优先采用的固定译法)】');
      g.forEach(function (t) {
        var note = t.note ? '（' + t.note + '）' : '';
        lines.push('- "' + t.source.replace(/[\r\n]+/g, ' ') + '" → "' + String(t.target || '').replace(/[\r\n]+/g, ' ') + '"' + note);
      });
      lines.push('');
    }
    if (ex.length) {
      lines.push('【用户参考例句(仅供体会风格与固定说法，不要照搬到译文里)】');
      ex.forEach(function (e, i) {
        lines.push((i + 1) + '. ' + String(e.src || '').replace(/[\r\n]+/g, ' ') + ' → ' + String(e.tgt || '').replace(/[\r\n]+/g, ' '));
      });
      lines.push('');
    }
    lines.push('【输出格式】');
    lines.push('只返回一个 JSON 对象，不要 markdown 代码块、不要任何解释文字：');
    lines.push('{"results":[{"id":"i0","zh":"译文"}, ...]}');
    return lines.join('\n');
  }

  /** 从模型返回中稳健解析 {results:[{id,zh}]}，返回 Map id->zh */
  function parseResultJSON(raw) {
    var text = String(raw || '').trim();
    // 去掉可能出现的 ```json 围栏
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var data = null;
    try { data = JSON.parse(text); } catch (e) {
      var s = text.indexOf('{'), e2 = text.lastIndexOf('}');
      if (s !== -1 && e2 > s) {
        try { data = JSON.parse(text.slice(s, e2 + 1)); } catch (e3) { data = null; }
      }
    }
    var list = null;
    if (data && Array.isArray(data.results)) list = data.results;
    else if (Array.isArray(data)) list = data;
    var map = {};
    if (list) {
      list.forEach(function (r) {
        if (r && r.id != null && r.zh != null) map[String(r.id)] = String(r.zh);
      });
    }
    return map;
  }

  /** 规范化接口地址 → chat/completions 完整 URL */
  function normalizeEndpoint(baseUrl) {
    var b = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v\d+$/.test(b)) return b + '/chat/completions';
    return b + '/chat/completions';
  }

  /** 按本机填写的单价估算本次请求费用（元） */
  function estimateCost(usage, prices) {
    prices = prices || {};
    var hit = usage.prompt_cache_hit_tokens || 0;
    var miss = Math.max(0, (usage.prompt_tokens || 0) - hit);
    var out = usage.completion_tokens || 0;
    var pMiss = Number(prices.priceInMiss) || 1;
    var pHit = Number(prices.priceInHit) || 0.02;
    var pOut = Number(prices.priceOut) || 4;
    return (miss * pMiss + hit * pHit + out * pOut) / 1e6;
  }

  /** 清洗错误信息：绝不回显 API Key */
  function sanitizeError(msg) {
    var s = String(msg || '未知错误');
    s = s.replace(/sk-[A-Za-z0-9\-_.]+/g, 'sk-***');
    s = s.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, 'Bearer ***');
    s = s.replace(/api[_-]?key["\s:=]+[A-Za-z0-9\-_.]+/gi, 'api_key=***');
    return s.slice(0, 400);
  }

  var DEFAULTS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 0.3,
    priceInMiss: 1,
    priceInHit: 0.02,
    priceOut: 4,
    batchChar: 3500,
    maxBatchItems: 20,
    ackConfirmed: false
  };

  root.FicTrans = {
    detectLang: detectLang,
    shouldTranslateText: shouldTranslateText,
    splitLongText: splitLongText,
    pickGlossary: pickGlossary,
    pickExamples: pickExamples,
    buildSystemPrompt: buildSystemPrompt,
    parseResultJSON: parseResultJSON,
    normalizeEndpoint: normalizeEndpoint,
    estimateCost: estimateCost,
    sanitizeError: sanitizeError,
    DEFAULTS: DEFAULTS
  };
})(typeof self !== 'undefined' ? self : this);
