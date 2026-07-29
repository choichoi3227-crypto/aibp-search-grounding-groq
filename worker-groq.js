/**
 * AIBP Search Grounding Worker (Groq 기반)
 * ------------------------------------------------------------------
 * 역할: Gemini API 내장 그라운딩(tools: google_search)이 무료 티어에서
 *       429(quota exceeded)로 사실상 완전히 막혀 있는 문제를 우회하기 위해,
 *       검색은 Groq의 groq/compound 모델(Tavily 기반 웹 검색 내장)이 대신
 *       수행하고, 정리된 결과를 JSON으로 반환한다.
 *       워드프레스 플러그인은 이 결과를 Gemini 프롬프트 앞부분에 텍스트로
 *       삽입해서, Gemini 쪽 요청에는 더 이상 google_search 툴을 쓰지 않는다.
 *
 * 왜 Groq인가:
 *   - groq/compound 모델은 자체적으로 웹 검색(Tavily 제공)을 수행하고
 *     search_results(title/url/content/score)를 그대로 반환해준다.
 *   - 무료 티어 한도: RPM 30 / RPD 250 / TPM 70K (2026-07 기준, Groq 공식 문서)
 *     → Gemini 그라운딩이 사실상 0에 가까웠던 것과 비교해 훨씬 여유롭다.
 *   - 별도의 검색 전용 API 키가 필요 없고, Groq API 키 하나로 끝난다.
 *
 * 엔드포인트: POST /  (또는 GET /?q=검색어)
 * 요청 바디(JSON): { "query": "검색어", "max_results": 5 }
 * 요청 헤더: X-AIBP-Secret: <공유비밀키>  (Worker Secret으로 등록해야 함)
 * 응답(JSON):
 *   {
 *     "query": "검색어",
 *     "summary": "Groq이 검색 결과를 종합해 정리한 텍스트",
 *     "results": [
 *       { "title": "...", "url": "...", "content": "...", "score": 0.81 },
 *       ...
 *     ],
 *     "source": "groq-compound",
 *     "fetched_at": "2026-07-29T12:00:00.000Z"
 *   }
 *
 * 배포 전 필수: wrangler secret put GROQ_API_KEY
 *              wrangler secret put AIBP_SHARED_SECRET
 */

const DEFAULT_MAX_RESULTS = 5;
const MAX_ALLOWED_RESULTS = 10;
const FETCH_TIMEOUT_MS    = 20000; // Groq 검색+합성은 단순 스크래핑보다 시간이 더 걸릴 수 있음

// 이 Worker를 호출할 수 있는 출처를 제한하고 싶다면 워드프레스 도메인을 넣으세요.
// 비워두면(빈 배열) Origin 검사는 생략하고 X-AIBP-Secret 인증만 적용합니다.
const ALLOWED_ORIGINS = []; // 예: ['https://your-wordpress-site.com']

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse({ error: 'POST 또는 GET만 허용됩니다.' }, 405);
    }

    // ── 인증: 공유 비밀키 확인 ──
    const authHeader = request.headers.get('X-AIBP-Secret') || '';
    if (env.AIBP_SHARED_SECRET && authHeader !== env.AIBP_SHARED_SECRET) {
      return jsonResponse({ error: '인증 실패 (X-AIBP-Secret 헤더 확인 필요)' }, 401);
    }

    if (!env.GROQ_API_KEY) {
      return jsonResponse({ error: 'Worker에 GROQ_API_KEY가 설정되지 않았습니다 (wrangler secret put GROQ_API_KEY).' }, 500);
    }

    // Origin 제한(선택)
    if (ALLOWED_ORIGINS.length > 0) {
      const origin = request.headers.get('Origin') || '';
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return jsonResponse({ error: '허용되지 않은 출처입니다.' }, 403);
      }
    }

    let query = '';
    let maxResults = DEFAULT_MAX_RESULTS;
    let country = ''; // 예: 'south korea' — 한국 콘텐츠 우선 검색하려면 지정

    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        query = (url.searchParams.get('q') || '').trim();
        maxResults = parseInt(url.searchParams.get('max_results') || '', 10) || DEFAULT_MAX_RESULTS;
        country = (url.searchParams.get('country') || '').trim();
      } else {
        const body = await request.json();
        query = (body.query || '').trim();
        maxResults = parseInt(body.max_results, 10) || DEFAULT_MAX_RESULTS;
        country = (body.country || '').trim();
      }
    } catch (e) {
      return jsonResponse({ error: '요청 본문을 파싱할 수 없습니다 (JSON 형식 확인).' }, 400);
    }

    if (!query) {
      return jsonResponse({ error: 'query 파라미터가 비어 있습니다.' }, 400);
    }
    maxResults = Math.min(Math.max(1, maxResults), MAX_ALLOWED_RESULTS);

    try {
      const data = await searchWithGroqCompound(query, maxResults, country, env);
      return jsonResponse({
        query,
        summary: data.summary,
        results: data.results,
        source: 'groq-compound',
        fetched_at: new Date().toISOString(),
      }, 200);
    } catch (err) {
      return jsonResponse({
        error: '검색 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)),
        query,
      }, 502);
    }
  },
};

/* ────────────────────────────────────────────────────────────
 * Groq groq/compound 모델 호출 — 내장 웹 검색(Tavily) 자동 수행.
 * 모델이 알아서 검색이 필요한지 판단해 검색을 실행하고, 최종 종합 답변과
 * 원본 검색 결과(search_results)를 함께 반환한다.
 * ──────────────────────────────────────────────────────────── */
async function searchWithGroqCompound(query, maxResults, country, env) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const searchSettings = {};
  if (country) searchSettings.country = country;

  const payload = {
    model: 'groq/compound',
    messages: [
      {
        role: 'user',
        content:
          '다음 주제에 대해 최신 웹 정보를 검색하고, 핵심 사실 위주로 간결하게 정리해줘. ' +
          '블로그 글 작성에 참고할 자료 수집이 목적이므로 과장 없이 사실만 나열해줘.\n\n주제: ' + query,
      },
    ],
  };
  if (Object.keys(searchSettings).length > 0) {
    payload.search_settings = searchSettings;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.GROQ_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('Groq API 응답 실패: HTTP ' + res.status + ' ' + errBody.slice(0, 300));
  }

  const data = await res.json();
  const message = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message
    : {};

  const summary = message.content || '';

  // executed_tools[].search_results.results 에 원본 검색 결과가 들어있다.
  let rawResults = [];
  if (Array.isArray(message.executed_tools)) {
    for (const tool of message.executed_tools) {
      if (tool && tool.search_results && Array.isArray(tool.search_results.results)) {
        rawResults = rawResults.concat(tool.search_results.results);
      }
    }
  }

  const results = rawResults.slice(0, maxResults).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
    score: typeof r.score === 'number' ? r.score : null,
  }));

  return { summary, results };
}

/* ── 공통 유틸 ── */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-AIBP-Secret',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}
