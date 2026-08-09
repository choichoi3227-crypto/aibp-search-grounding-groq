/**
 * AIBP Search Grounding Worker (Groq 기반)
 * ------------------------------------------------------------------
 * 역할: 키워드에 대한 "주제 조사"를 이 Worker가 전부 끝까지 수행한다.
 *       Groq의 groq/compound 모델(Tavily 기반 웹 검색 내장)이 최신 웹
 *       정보를 검색하고, 그 검색 결과를 바탕으로 AI 이미지 프롬프트 생성에
 *       필요한 구조화된 JSON(실제 의미, 시각화 대상, 색상 분위기 등)까지
 *       이 Worker 안에서 직접 만들어 반환한다.
 *
 * ⚠️ 2026-08 개편 (2차): 기존에는 이 Worker가 "검색 결과 요약 텍스트"만
 *    돌려주고, 워드프레스 쪽에서 그 텍스트를 다시 Gemini에 넘겨 Gemini가
 *    조사(actual_meaning/visual_context/hero_shot 등 JSON)를 수행했다.
 *    이제는 그 조사 단계 전체를 이 Worker가 맡는다 — Gemini는 더 이상
 *    "주제가 무엇을 의미하는가"를 조사하지 않고, 이 Worker가 이미 조사해
 *    구조화해준 결과를 받아 "이미지 프롬프트 문장 작성"만 담당한다.
 *    (워드프레스 플러그인 측 Phase A의 Gemini 호출은 완전히 제거됨)
 *
 * 엔드포인트: POST /  (또는 GET /?q=검색어)
 * 요청 바디(JSON): { "query": "검색어", "max_results": 8, "country": "south korea" }
 * 요청 헤더: X-AIBP-Secret: <공유비밀키>  (Worker Secret으로 등록해야 함)
 *
 * 응답(JSON) — 검색 요약/원본 결과에 더해 구조화된 조사 필드를 함께 반환:
 *   {
 *     "query": "검색어",
 *     "summary": "Groq이 검색 결과를 종합해 정리한 텍스트",
 *     "results": [ { "title", "url", "content", "score" }, ... ],
 *     "research": {
 *       "actual_meaning": "이 키워드가 한국 독자에게 실제로 의미하는 것 (1문장)",
 *       "visual_context": "이미지화 대상 (구체적 장면/오브젝트, 영문)",
 *       "hero_shot": "가장 임팩트 있는 단 하나의 시각 장면 (영문)",
 *       "color_mood": "색상 분위기 (영문, 예: warm golden tones)",
 *       "key_visuals": ["영문 시각요소1", "영문 시각요소2", "영문 시각요소3", "영문 시각요소4"],
 *       "category": "앱/서비스|음식|IT기술|금융|건강|교육|라이프스타일|엔터테인먼트|인물|제품|기타",
 *       "wrong_interpretation": "잘못 해석 시 발생할 오류 (간결, 없으면 빈 문자열)",
 *       "emotional_tone": "urgent|trustworthy|exciting|calm|dynamic|premium 중 하나",
 *       "text_color_hex": "#FFFFFF",
 *       "accent_color_hex": "#FFD400"
 *     },
 *     "source": "groq-compound",
 *     "fetched_at": "2026-08-09T12:00:00.000Z"
 *   }
 *
 * research 필드 생성에 실패한 경우(모델이 JSON을 못 만든 경우 등)에도
 * summary/results는 최대한 채워서 반환하고, research는 최소한의 안전한
 * 기본값(빈 문자열/기본 톤)으로 채워 절대 필드 자체가 누락되지 않게 한다.
 * 워드프레스 쪽에서 "research 필드가 아예 없다"는 상황을 겪지 않도록
 * 이 Worker가 항상 유효한 구조를 보장하는 것이 핵심 계약이다.
 *
 * 배포 전 필수: wrangler secret put GROQ_API_KEY
 *              wrangler secret put AIBP_SHARED_SECRET
 */

const DEFAULT_MAX_RESULTS = 8;
const MAX_ALLOWED_RESULTS = 10;
// ⚠️ 이 Worker는 요청 하나당 "검색"과 "조사(JSON화)" 두 번의 Groq 호출을 순차로
// 수행한다. 워드프레스 쪽(wp_remote_post)의 실제 콜 타임아웃은 고정 40초가
// 아니라 남은 예산에 따라 최소 8초까지도 내려갈 수 있다(재시도 1차가 실패해
// 시간을 많이 소모한 뒤 2차 호출의 타임아웃이 훨씬 짧아지는 식). 즉 Worker는
// "최악의 경우 워드프레스가 8초만에 연결을 끊을 수도 있다"는 전제로 동작해야
// 하므로, 내부에서 429/413을 만나 여러 초씩 대기하는 재시도는 오히려 역효과—
// 워드프레스가 먼저 연결을 끊어버려 재시도 시도 자체가 낭비된다.
// → 각 단계 타임아웃을 줄이고, 재시도 대기는 짧게, 재시도 자체도 최소화한다.
const FETCH_TIMEOUT_MS    = 12000;

// ⚠️ 413(Request Entity Too Large) 방지용 하드 캡.
// Groq API로 보내는 요청 바디는 항상 이 값들 이하로 강제로 잘라낸다.
// 어느 한쪽(워드프레스 쪽 topic이 비정상적으로 길게 들어오거나, 1단계 검색
// 응답 summary가 예상보다 길게 나오는 경우 등)이 무제한으로 커지더라도
// Groq 호출 자체는 항상 작고 안전한 크기를 유지하도록 하는 것이 목적이다.
const MAX_QUERY_CHARS      = 300;   // 사용자가 넘긴 검색 주제(query) 최대 길이
const MAX_SUMMARY_CHARS    = 1500;  // 1단계 검색 요약(summary)을 2단계 프롬프트에 재사용할 때 최대 길이
const MAX_SNIPPET_CHARS    = 150;   // 검색 결과 각 항목의 본문 스니펫 최대 길이
const MAX_SOURCE_LINES     = 5;     // 2단계 프롬프트에 포함할 출처 개수
const MAX_RESEARCH_PAYLOAD_CHARS = 7000; // 2단계 Groq 요청 바디 전체에 대한 최종 안전장치(문자 수 기준)

// 배포 확인용 버전 마커 — 응답의 "worker_version" 필드로 노출된다.
// 이 값이 바뀌어 보이면 최신 코드가 실제로 배포된 것이고, 예전 값이 보이면
// 캐시되었거나 재배포가 안 된 것이다.
const WORKER_VERSION = '2026-08-09-413fix-7-fast-fail';

// 1단계(검색)는 웹 검색 도구가 내장된 groq/compound가 반드시 필요하다.
// 2단계(조사 JSON 생성)는 순수 텍스트 → JSON 변환 작업이라 웹 검색이 전혀
// 필요 없는데도 지금까지는 똑같이 groq/compound를 썼다. groq/compound는
// 내부적으로 여러 서브모델을 태우는 무거운 에이전틱 모델이라 TPM(분당 토큰)
// 소비가 훨씬 크고, 이게 "요청 바디는 짧은데도 413(TPM 초과)이 뜨는" 현상의
// 근본 원인이었다. 2단계는 훨씬 가벼운 일반 모델로 분리해 TPM 소비 자체를
// 줄인다(속도도 더 빠르다).
const SEARCH_MODEL   = 'groq/compound';
const RESEARCH_MODEL = 'llama-3.3-70b-versatile';

// ⚠️ 워드프레스 쪽 wp_remote_post 타임아웃이 실제로는 최소 8초까지도 내려갈
// 수 있음이 확인되었다(재시도 2차 호출에서 16초로 관측됨 — 1차 실패로 예산을
// 많이 소모한 뒤 2차 timeout이 짧게 계산됨). 이는 Worker 응답이 그보다 느리면
// 워드프레스가 먼저 연결을 끊는다는 뜻이므로, Worker는 절대적으로 짧고
// 예측 가능한 시간 안에 응답을 마쳐야 한다. 내부 처리(검색+조사+재시도 대기
// 전부 포함) 총 예산을 25초로 강하게 제한해, 어떤 상황에서도 워드프레스의
// 최소 타임아웃(관측상 16~40초)보다 여유 있게 먼저 응답하도록 한다.
const TOTAL_BUDGET_MS = 25000;

// 이 Worker를 호출할 수 있는 출처를 제한하고 싶다면 워드프레스 도메인을 넣으세요.
// 비워두면(빈 배열) Origin 검사는 생략하고 X-AIBP-Secret 인증만 적용합니다.
const ALLOWED_ORIGINS = []; // 예: ['https://your-wordpress-site.com']

// research 필드가 비어있거나 모델이 실패했을 때 사용할 안전한 기본값.
// 여기의 값들은 "조사 실패를 감추기 위한 그럴듯한 추측"이 아니라, 단지 필드
// 누락으로 워드프레스 쪽 JSON 파싱이 깨지지 않도록 하는 최소한의 중립값이다.
function emptyResearch(query) {
  return {
    actual_meaning: query,
    visual_context: '',
    hero_shot: '',
    color_mood: '',
    key_visuals: [],
    category: '기타',
    wrong_interpretation: '',
    emotional_tone: 'dynamic',
    text_color_hex: '#FFFFFF',
    accent_color_hex: '#FFD400',
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ── 진단용 엔드포인트: GET /debug-groq ──
    // Worker의 다른 로직을 전혀 거치지 않고, Groq API에 아주 짧고 안전한
    // 요청 하나만 직접 보내서 원본 응답(상태코드/에러 바디)을 그대로 반환한다.
    // 413이 코드 문제가 아니라 Groq API 키/계정 문제인지 확인하기 위한 용도.
    // (API 키는 앞 4자리·길이만 노출하고 전체는 절대 노출하지 않는다.)
    const urlForDebug = new URL(request.url);
    if (request.method === 'GET' && urlForDebug.pathname === '/debug-groq') {
      const authHeader = request.headers.get('X-AIBP-Secret') || '';
      if (env.AIBP_SHARED_SECRET && authHeader !== env.AIBP_SHARED_SECRET) {
        return jsonResponse({ error: '인증 실패 (X-AIBP-Secret 헤더 확인 필요)' }, 401);
      }
      if (!env.GROQ_API_KEY) {
        return jsonResponse({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' }, 500);
      }
      const keyInfo = {
        key_length: env.GROQ_API_KEY.length,
        key_prefix: env.GROQ_API_KEY.slice(0, 4),
        key_has_whitespace: /\s/.test(env.GROQ_API_KEY),
      };

      // 테스트 A: search_settings 없이 (성공했던 케이스)
      const bodyA = JSON.stringify({
        model: 'groq/compound',
        messages: [ { role: 'user', content: '안녕' } ],
      });
      // 테스트 B: search_settings.country 포함 (1단계 검색과 동일한 형태 —
      // 실제로 413이 나는 것으로 의심되는 조합)
      const bodyB = JSON.stringify({
        model: 'groq/compound',
        messages: [ { role: 'user', content: '안녕' } ],
        search_settings: { country: 'south korea' },
      });

      async function tryGroq(body) {
        try {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + env.GROQ_API_KEY,
            },
            body,
          });
          const text = await r.text().catch(() => '');
          return { sent_body_bytes: body.length, status: r.status, body: text.slice(0, 500) };
        } catch (e) {
          return { sent_body_bytes: body.length, fetch_error: String(e) };
        }
      }

      const [resultA, resultB] = await Promise.all([ tryGroq(bodyA), tryGroq(bodyB) ]);

      return jsonResponse({
        worker_version: WORKER_VERSION,
        key_info: keyInfo,
        test_A_no_search_settings: resultA,
        test_B_with_search_settings: resultB,
      }, 200);
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
    let wantResearch = true; // 구조화된 조사 JSON도 함께 만들지 여부 (기본 true)

    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        query = (url.searchParams.get('q') || '').trim();
        maxResults = parseInt(url.searchParams.get('max_results') || '', 10) || DEFAULT_MAX_RESULTS;
        country = (url.searchParams.get('country') || '').trim();
        wantResearch = url.searchParams.get('research') !== '0';
      } else {
        const body = await request.json();
        query = (body.query || '').trim();
        maxResults = parseInt(body.max_results, 10) || DEFAULT_MAX_RESULTS;
        country = (body.country || '').trim();
        wantResearch = body.research !== false && body.research !== 0;
      }
    } catch (e) {
      return jsonResponse({ error: '요청 본문을 파싱할 수 없습니다 (JSON 형식 확인).' }, 400);
    }

    if (!query) {
      return jsonResponse({ error: 'query 파라미터가 비어 있습니다.' }, 400);
    }
    // ⚠️ 413 방지: 호출 측(워드프레스 등)이 실수로 매우 긴 텍스트(예: 글 전체
    // 프롬프트)를 query로 넘기더라도, 여기서 즉시 안전한 길이로 잘라 이후
    // Groq 호출들이 절대 과도하게 커지지 않도록 한다.
    query = truncate(query, MAX_QUERY_CHARS);
    maxResults = Math.min(Math.max(1, maxResults), MAX_ALLOWED_RESULTS);

    const deadlineTs = Date.now() + TOTAL_BUDGET_MS;

    try {
      const data = await searchAndResearchWithGroq(query, maxResults, country, wantResearch, env, deadlineTs);
      return jsonResponse({
        query,
        summary: data.summary,
        results: data.results,
        research: data.research,
        source: 'groq-compound',
        fetched_at: new Date().toISOString(),
        worker_version: WORKER_VERSION,
      }, 200);
    } catch (err) {
      return jsonResponse({
        error: '검색 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)),
        query,
        worker_version: WORKER_VERSION,
      }, 502);
    }
  },
};

/* ────────────────────────────────────────────────────────────
 * 1단계: groq/compound 모델로 웹 검색(Tavily 내장) 수행.
 * 2단계: 검색 결과를 바탕으로 groq/compound 모델에게 다시 한번,
 *        이미지 프롬프트 생성에 필요한 구조화된 JSON을 만들도록 요청.
 * (필요 없으면 wantResearch=false로 2단계를 건너뛸 수 있다.)
 * ──────────────────────────────────────────────────────────── */
async function searchAndResearchWithGroq(query, maxResults, country, wantResearch, env, deadlineTs) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const searchSettings = {};
  if (country) searchSettings.country = country;

  // ── 1단계: 검색 + 요약 (웹 검색 도구가 필요하므로 groq/compound 사용) ──
  const searchPayload = {
    model: SEARCH_MODEL,
    messages: [
      {
        role: 'user',
        content:
          '다음 주제에 대해 최신 웹 정보를 검색하고, 핵심 사실 위주로 간결하게 정리해줘. ' +
          '블로그 글/이미지 제작에 참고할 자료 수집이 목적이므로 과장 없이 사실만 나열해줘.\n\n주제: ' + query,
      },
    ],
  };
  if (Object.keys(searchSettings).length > 0) {
    searchPayload.search_settings = searchSettings;
  }

  const searchData = await callGroq(endpoint, searchPayload, env, FETCH_TIMEOUT_MS, '1단계(검색)', deadlineTs - Date.now());
  const searchMessage = searchData && searchData.choices && searchData.choices[0] && searchData.choices[0].message
    ? searchData.choices[0].message
    : {};

  const summary = searchMessage.content || '';

  let rawResults = [];
  if (Array.isArray(searchMessage.executed_tools)) {
    for (const tool of searchMessage.executed_tools) {
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

  if (!wantResearch) {
    return { summary, results, research: emptyResearch(query) };
  }

  // ── 2단계: 위 검색 결과를 근거로 이미지 프롬프트용 구조화 JSON 조사 ──
  const research = await buildResearchJson(query, summary, results, country, env, deadlineTs);

  return { summary, results, research };
}

/* 검색 결과(summary + results)를 근거로 이미지 프롬프트 조사 JSON을 만든다.
 * 여기서는 별도 검색 도구를 다시 붙이지 않고(이미 1단계에서 검색을 마쳤으므로),
 * 위에서 얻은 근거 텍스트만 프롬프트에 넣어 순수 텍스트 생성으로 JSON을 뽑는다.
 * 이렇게 하면 groq/compound가 다시 웹 검색을 반복 실행하지 않아 응답 속도가 빨라진다. */
async function buildResearchJson(query, summary, results, country, env, deadlineTs) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  // ⚠️ 413 방지: 1단계 groq/compound가 예상보다 긴 요약을 반환하는 경우에도
  // 2단계 프롬프트가 과도하게 커지지 않도록 상한을 둔다.
  const safeSummary = truncate(summary, MAX_SUMMARY_CHARS);

  const sourceLines = results
    .slice(0, MAX_SOURCE_LINES)
    .map((r) => {
      const snippet = truncate(r.content || '', MAX_SNIPPET_CHARS);
      return `- ${truncate(r.title || '', 150)} (${truncate(r.url || '', 300)})\n  ${snippet}`;
    })
    .join('\n');

  const researchPrompt = `한국 비주얼 콘텐츠 전문가로서, 아래 키워드와 검색 결과를 근거로 이미지 생성용 정보를 JSON으로 추출하세요.

[키워드]: ${query}
[검색 요약]: ${safeSummary || '(없음)'}
[출처]: ${sourceLines || '(없음 — 보유 지식 활용)'}

【브랜드 오역 방지 — 독립 단어로 등장할 때만 적용, 다른 단어의 일부 음절이면 무시】
알약(앱)→보안SW / 토스(앱)→핀테크 / 카카오(브랜드)→IT기업 / 네이버→검색엔진 / 배민→배달앱 / 당근(브랜드)→중고거래앱 / 쿠팡→이커머스 / 지코→K-pop아티스트(zico)
"예약/계약/약속/약국" 등은 "알약"과 무관, 의약품 이미지 연상 금지.

【지침】
- 브랜드 로고·워드마크·실제 UI를 재현하지 말고 해당 카테고리를 대표하는 독창적 그래픽 은유로 표현(상표권 보호)
- visual_context/hero_shot/key_visuals에 사람·얼굴·인물·실루엣 절대 금지(특정 인물이 주제인 경우 제외)
- 색상은 배경과 대비되는 텍스트색+액센트색을 HEX로 지정

아래 JSON 형식으로만, 코드블록 없이 순수 JSON만 출력하세요:
{
  "actual_meaning": "실제 의미 (1문장)",
  "visual_context": "이미지화 대상 (영문 묘사)",
  "hero_shot": "핵심 시각 장면 (영어)",
  "color_mood": "색상 분위기 (영어)",
  "key_visuals": ["영어 시각요소1", "영어 시각요소2", "영어 시각요소3", "영어 시각요소4"],
  "category": "앱/서비스|음식|IT기술|금융|건강|교육|라이프스타일|엔터테인먼트|인물|제품|기타",
  "wrong_interpretation": "잘못 해석 시 오류 (간결히, 없으면 빈 문자열)",
  "emotional_tone": "urgent|trustworthy|exciting|calm|dynamic|premium 중 하나",
  "text_color_hex": "#FFFFFF",
  "accent_color_hex": "#FFD400"
}`;

  let researchPayload = {
    model: RESEARCH_MODEL,
    messages: [ { role: 'user', content: researchPrompt } ],
    temperature: 0.4,
  };

  // ⚠️ 최종 안전장치: 위의 개별 길이 제한(query/summary/snippet)을 모두
  // 적용했는데도 프롬프트 총 길이가 비정상적으로 큰 경우, 413을 아예
  // 겪지 않도록 출처 상세를 제거하고 요약만으로 재구성한다.
  if (JSON.stringify(researchPayload).length > MAX_RESEARCH_PAYLOAD_CHARS) {
    const fallbackPrompt = researchPrompt.replace(sourceLines, '(생략됨 — 요약만 참고)');
    researchPayload = {
      model: RESEARCH_MODEL,
      messages: [ { role: 'user', content: fallbackPrompt } ],
      temperature: 0.4,
    };
  }

  // ⚠️ 그래도 여전히 크면(극단적 케이스), 아예 최소 프롬프트로 재구성해
  // 413을 절대 겪지 않도록 한다.
  if (JSON.stringify(researchPayload).length > MAX_RESEARCH_PAYLOAD_CHARS) {
    const minimalPrompt = `한국 비주얼 콘텐츠 전문가로서 아래 키워드에 대한 이미지 생성용 정보를 JSON으로 추출하세요.
[키워드]: ${truncate(query, 200)}
visual_context/hero_shot/key_visuals에 사람·얼굴·인물 절대 금지, 실제 브랜드 로고/UI 재현 금지.
JSON만 출력: {"actual_meaning":"","visual_context":"","hero_shot":"","color_mood":"","key_visuals":[],"category":"","wrong_interpretation":"","emotional_tone":"dynamic","text_color_hex":"#FFFFFF","accent_color_hex":"#FFD400"}`;
    researchPayload = {
      model: RESEARCH_MODEL,
      messages: [ { role: 'user', content: minimalPrompt } ],
      temperature: 0.4,
    };
  }

  let researchData;
  try {
    researchData = await callGroq(endpoint, researchPayload, env, FETCH_TIMEOUT_MS, '2단계(조사)', deadlineTs ? deadlineTs - Date.now() : undefined);
  } catch (e) {
    // 2단계(JSON 조사)가 실패해도 1단계 검색 결과는 이미 확보했으므로,
    // research는 안전한 기본값으로 채워서 반환한다 (호출 자체를 실패시키지 않음).
    return emptyResearch(query);
  }

  const message = researchData && researchData.choices && researchData.choices[0] && researchData.choices[0].message
    ? researchData.choices[0].message
    : {};
  let text = (message.content || '').trim();

  // 코드블록으로 감싸서 나오는 경우 제거
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return emptyResearch(query);
  }

  const base = emptyResearch(query);
  const out = {
    actual_meaning: typeof parsed.actual_meaning === 'string' && parsed.actual_meaning.trim() ? parsed.actual_meaning.trim() : base.actual_meaning,
    visual_context: typeof parsed.visual_context === 'string' ? parsed.visual_context.trim() : base.visual_context,
    hero_shot: typeof parsed.hero_shot === 'string' ? parsed.hero_shot.trim() : base.hero_shot,
    color_mood: typeof parsed.color_mood === 'string' ? parsed.color_mood.trim() : base.color_mood,
    key_visuals: Array.isArray(parsed.key_visuals) ? parsed.key_visuals.filter((v) => typeof v === 'string').slice(0, 6) : base.key_visuals,
    category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim() : base.category,
    wrong_interpretation: typeof parsed.wrong_interpretation === 'string' ? parsed.wrong_interpretation.trim() : base.wrong_interpretation,
    emotional_tone: typeof parsed.emotional_tone === 'string' && parsed.emotional_tone.trim() ? parsed.emotional_tone.trim() : base.emotional_tone,
    text_color_hex: normalizeHex(parsed.text_color_hex, base.text_color_hex),
    accent_color_hex: normalizeHex(parsed.accent_color_hex, base.accent_color_hex),
  };

  return out;
}

function normalizeHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

async function callGroq(endpoint, payload, env, timeoutMs, stageLabel, remainingBudgetMs) {
  const bodyStr = JSON.stringify(payload);

  // ⚠️ 2026-08 확인: Groq는 "요청 바디가 실제로 큰 경우"뿐 아니라, 모델의
  // TPM(분당 토큰) 한도를 초과했을 때도 HTTP 413("Request too large ...
  // tokens per minute (TPM): Limit X, Requested Y")을 반환한다(429와 함께
  // 사실상 같은 rate-limit 계열 에러). 요청 바디가 219자처럼 매우 짧아도
  // groq/compound처럼 내부적으로 여러 서브모델·검색 도구를 태우는 모델은
  // 실제 소비 토큰이 훨씬 커서 이 한도에 쉽게 걸릴 수 있다.
  // → "요청이 크다"는 문구에 속지 말고 429/413을 동일한 TPM 초과로 취급한다.
  //
  // ⚠️ 2026-08(413fix-7): 워드프레스 쪽 wp_remote_post 타임아웃이 실제로는
  // 최소 8초까지도 내려갈 수 있음이 확인되어(재시도 2차 호출에서 16초로
  // 관측), Worker가 재시도 대기로 시간을 오래 끌면 워드프레스가 먼저 연결을
  // 끊어버려 재시도 자체가 무의미해진다. 재시도는 "실패를 빠르게 확정"하는
  // 정도로만 1회 허용하고, 대기시간도 짧게(최대 4초) 제한한다. 재시도로도
  // 실패하면 즉시 명확한 에러를 반환해 워드프레스 쪽 재시도(최대 2회)가
  // 정상적으로 여러 번 시도할 시간을 벌어준다.
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.GROQ_API_KEY,
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      // fetch 자체가 실패(네트워크/타임아웃)한 경우는 재시도해도 대부분
      // 같은 이유로 실패하므로 바로 원인을 알 수 있게 던진다.
      const label = stageLabel ? `[${stageLabel}] ` : '';
      throw new Error(label + 'Groq API 호출 실패(네트워크/타임아웃): ' + (fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr)));
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return res.json();
    }

    const errBody = await res.text().catch(() => '');
    const isRateLimited = res.status === 429 || res.status === 413;

    // 대기시간은 아주 짧게만 준다(최대 4초) — 워드프레스가 훨씬 이른 시점에
    // 연결을 끊을 수 있으므로, TPM 윈도우 리셋을 기다리는 긴 대기는 이
    // 위치에서는 의미가 없다(어차피 응답을 못 받고 끊긴다). 남은 예산이
    // 재시도 1회조차 감당할 수 없을 만큼 적으면(500ms 미만) 재시도를 포기하고
    // 바로 에러를 던져 워드프레스 쪽 재시도(최대 2회)가 시간을 낭비하지
    // 않도록 한다.
    const remaining = typeof remainingBudgetMs === 'number' ? remainingBudgetMs - timeoutMs : 8000;
    const waitMs = Math.min(4000, remaining);

    if (isRateLimited && attempt < MAX_RETRIES && waitMs >= 500) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const label = stageLabel ? `[${stageLabel}, 요청 바디 ${bodyStr.length}자, ${byteLengthUtf8(bodyStr)}바이트] ` : '';
    const hint = isRateLimited
      ? ' — Groq 무료 티어의 분당 토큰 한도(TPM)를 초과했습니다(요청 바디 크기 문제가 아닙니다). https://console.groq.com/settings/billing 에서 Dev Tier로 업그레이드하거나, 잠시 후 다시 시도해주세요.'
      : '';
    throw new Error(label + 'Groq API 응답 실패: HTTP ' + res.status + ' ' + errBody.slice(0, 500) + hint);
  }
}

function byteLengthUtf8(str) {
  return new TextEncoder().encode(str).length;
}

/* ── 공통 유틸 ── */
// 문자열을 최대 길이로 안전하게 자른다(문자 단위, 서로게이트 페어는 고려하지
// 않지만 이 용도로는 충분함 — 잘려도 요청 실패보다 낫다).
function truncate(str, maxChars) {
  if (typeof str !== 'string') return '';
  return str.length > maxChars ? str.slice(0, maxChars) + '…' : str;
}

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
