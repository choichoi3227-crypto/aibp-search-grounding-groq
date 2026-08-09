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
// 수행한다. 워드프레스 플러그인 쪽 전체 예산이 CloudFront 등 오리진 타임아웃
// (약 60초) 안에서 두 호출 + 그 뒤의 Gemini 프롬프트 생성까지 끝나야 하므로,
// 각 단계별 타임아웃을 18초로 두어 최악의 경우에도 두 단계 합쳐 36초 안팎에서
// 끝나도록 한다(검색 단계가 오래 걸리는 극단적 케이스에도 조사 단계가 실행될
// 여유를 확보하기 위함).
const FETCH_TIMEOUT_MS    = 18000;

// ⚠️ 413(Request Entity Too Large) 방지용 하드 캡.
// Groq API로 보내는 요청 바디는 항상 이 값들 이하로 강제로 잘라낸다.
// 어느 한쪽(워드프레스 쪽 topic이 비정상적으로 길게 들어오거나, 1단계 검색
// 응답 summary가 예상보다 길게 나오는 경우 등)이 무제한으로 커지더라도
// Groq 호출 자체는 항상 작고 안전한 크기를 유지하도록 하는 것이 목적이다.
const MAX_QUERY_CHARS      = 500;   // 사용자가 넘긴 검색 주제(query) 최대 길이
const MAX_SUMMARY_CHARS    = 4000;  // 1단계 검색 요약(summary)을 2단계 프롬프트에 재사용할 때 최대 길이
const MAX_SNIPPET_CHARS    = 300;   // 검색 결과 각 항목의 본문 스니펫 최대 길이
const MAX_SOURCE_LINES     = 8;     // 2단계 프롬프트에 포함할 출처 개수
const MAX_RESEARCH_PAYLOAD_CHARS = 12000; // 2단계 Groq 요청 바디 전체에 대한 최종 안전장치(문자 수 기준)

// 배포 확인용 버전 마커 — 응답의 "worker_version" 필드로 노출된다.
// 이 값이 바뀌어 보이면 최신 코드가 실제로 배포된 것이고, 예전 값이 보이면
// 캐시되었거나 재배포가 안 된 것이다.
const WORKER_VERSION = '2026-08-09-413fix-2';

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
      const tinyBody = JSON.stringify({
        model: 'groq/compound',
        messages: [ { role: 'user', content: '안녕' } ],
      });
      let debugRes;
      try {
        debugRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env.GROQ_API_KEY,
          },
          body: tinyBody,
        });
      } catch (e) {
        return jsonResponse({ worker_version: WORKER_VERSION, key_info: keyInfo, fetch_error: String(e) }, 502);
      }
      const debugBodyText = await debugRes.text().catch(() => '');
      return jsonResponse({
        worker_version: WORKER_VERSION,
        key_info: keyInfo,
        sent_body_bytes: tinyBody.length,
        groq_status: debugRes.status,
        groq_body: debugBodyText.slice(0, 1000),
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

    try {
      const data = await searchAndResearchWithGroq(query, maxResults, country, wantResearch, env);
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
async function searchAndResearchWithGroq(query, maxResults, country, wantResearch, env) {
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const searchSettings = {};
  if (country) searchSettings.country = country;

  // ── 1단계: 검색 + 요약 (기존 로직과 동일) ──
  const searchPayload = {
    model: 'groq/compound',
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

  const searchData = await callGroq(endpoint, searchPayload, env, FETCH_TIMEOUT_MS, '1단계(검색)');
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
  const research = await buildResearchJson(query, summary, results, country, env);

  return { summary, results, research };
}

/* 검색 결과(summary + results)를 근거로 이미지 프롬프트 조사 JSON을 만든다.
 * 여기서는 별도 검색 도구를 다시 붙이지 않고(이미 1단계에서 검색을 마쳤으므로),
 * 위에서 얻은 근거 텍스트만 프롬프트에 넣어 순수 텍스트 생성으로 JSON을 뽑는다.
 * 이렇게 하면 groq/compound가 다시 웹 검색을 반복 실행하지 않아 응답 속도가 빨라진다. */
async function buildResearchJson(query, summary, results, country, env) {
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

  const researchPrompt = `당신은 한국 미디어·문화·서비스·브랜드에 정통한 비주얼 콘텐츠 전문가입니다.
아래 키워드와 검색 결과를 바탕으로, 최고 품질 이미지 생성에 필요한 정보를 추출하세요.
반드시 아래 검색 결과(출처 및 상세 내용 포함)를 최우선 근거로 삼아 최신·정확한 사실에
기반해 조사하고, 구체적 디테일(색상, 형태, 최근 이슈, 캠페인, 시각적 특징 등)을 반영하세요.

[키워드]: ${query}

[검색 요약]
${safeSummary || '(요약 없음)'}

[검색 결과 상세]
${sourceLines || '(검색 결과 없음 — 보유 지식으로 최대한 정확하게 조사하세요)'}

【오역 방지 — 한국 고유 브랜드/서비스명 필수 확인】
아래는 "단어가 다른 뜻을 연상시키지만 실제로는 특정 브랜드·서비스를 가리키는" 사례입니다.
반드시 브랜드명 전체가 정확히, 독립된 단어로 키워드에 등장할 때만 적용하세요. 그 글자가
다른 단어의 일부 음절로만 우연히 포함된 경우(예: "사전예약"의 "약")는 이 목록과 무관하니
무시하고 원래 문맥 그대로 해석하세요.
- "알약" (앱 이름 전체로 등장할 때) → 한국 보안SW (일반 의약품 알약이 아님)
- "토스" (앱 이름으로 등장할 때) → 핀테크앱 (동사 "던지다"가 아님)
- "카카오" (브랜드로 등장할 때) → IT대기업 (열매 카카오가 아님)
- "네이버" → 검색엔진 (이웃neighbor이 아님)
- "배민" → 배달앱
- "당근" (브랜드로 등장할 때) → 중고거래앱 (채소 당근이 아님)
- "쿠팡" → 이커머스
- "지코" → K-pop 아티스트 (zico)
⚠️ 특히 주의: "예약", "계약", "약속", "약국" 등 "약"을 포함하는 일반 한국어 단어는 위
"알약" 항목과 전혀 무관합니다. 절대로 알약/영양제/의약품 이미지를 연상하지 마세요.

【분석 항목】
1. 이 키워드가 한국 독자에게 실제로 의미하는 것
2. 최고 품질 이미지로 표현할 때 사용해야 할 구체적 시각 요소 — 단, 키워드가 특정
   상용 앱/브랜드(예: 카카오톡, 알약, 토스 등)를 가리키더라도 그 브랜드의 실제
   로고·워드마크·정확한 화면 UI를 그대로 재현하라는 요소는 절대 포함하지 말고,
   해당 서비스 카테고리(메신저/보안SW/핀테크 등)를 대표하는 독창적이고 일반화된
   그래픽 은유로 표현할 것(상표권·저작권 보호)
3. 가장 임팩트 있는 단일 핵심 장면/오브젝트 (특정 브랜드 로고·UI를 베끼지 않는 선에서)
4. 색상 분위기 (따뜻한/차가운/중성, 대표 색상)
5. 잘못 그릴 경우 발생할 오류
6. 이 키워드의 감정적 톤 (긴급함/신뢰감/설렘/차분함/역동적/고급스러움 중 가장 가까운 것)
7. 텍스트 오버레이에 실제로 사용할 구체적 색상 — 배경과 확실히 대비되는 하나의 메인
   텍스트 색과, 포인트로 쓸 액센트 색을 HEX 코드로 지정

⚠️ 매우 중요 — 인물 배제: visual_context, hero_shot, key_visuals 어디에도 사람/인물/
얼굴/모델을 시각 요소로 넣지 마세요 (예: "여성", "남성", "모델", "인물", "person",
"woman", "model" 등 사용 금지). 이 키워드가 특정 인물(연예인, 정치인 등) 그 자체를
다루는 주제가 아닌 이상, 항상 사물·아이콘·장면 등 비인물 요소로만 표현하세요.

아래 JSON 형식으로만 답하세요. 코드블록이나 다른 텍스트 없이 순수 JSON만 출력하세요:
{
  "actual_meaning": "실제 의미 (1문장, 정확하게)",
  "visual_context": "이미지화 대상 (구체적 장면/오브젝트, 영문 묘사 포함)",
  "hero_shot": "가장 임팩트 있는 단 하나의 시각 장면 (영어로)",
  "color_mood": "색상 분위기 (영어로, 예: warm golden tones, cool tech blues)",
  "key_visuals": ["영어 시각요소1", "영어 시각요소2", "영어 시각요소3", "영어 시각요소4"],
  "category": "앱/서비스|음식|IT기술|금융|건강|교육|라이프스타일|엔터테인먼트|인물|제품|기타",
  "wrong_interpretation": "잘못 해석 시 오류 (간결하게, 없으면 빈 문자열)",
  "emotional_tone": "urgent|trustworthy|exciting|calm|dynamic|premium 중 하나",
  "text_color_hex": "배경과 대비되는 텍스트 메인 색상 HEX (예: #FFFFFF)",
  "accent_color_hex": "포인트 액센트 색상 HEX (예: #FFD400)"
}`;

  let researchPayload = {
    model: 'groq/compound',
    messages: [ { role: 'user', content: researchPrompt } ],
    temperature: 0.4,
  };

  // ⚠️ 최종 안전장치: 위의 개별 길이 제한(query/summary/snippet)을 모두
  // 적용했는데도 프롬프트 총 길이가 비정상적으로 큰 경우(예: 검색 결과
  // 항목 수가 많거나 다국어 인코딩 등으로 예상보다 커진 경우), 413을
  // 아예 겪지 않도록 출처 상세 내용을 통째로 제거하고 요약만으로 재구성한다.
  if (JSON.stringify(researchPayload).length > MAX_RESEARCH_PAYLOAD_CHARS) {
    const fallbackPrompt = researchPrompt.replace(
      /\[검색 결과 상세\][\s\S]*?(?=\n【오역 방지)/,
      '[검색 결과 상세]\n(검색 결과가 너무 길어 생략됨 — 검색 요약만 참고)\n\n'
    );
    researchPayload = {
      model: 'groq/compound',
      messages: [ { role: 'user', content: fallbackPrompt } ],
      temperature: 0.4,
    };
  }

  let researchData;
  try {
    researchData = await callGroq(endpoint, researchPayload, env, FETCH_TIMEOUT_MS, '2단계(조사)');
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

async function callGroq(endpoint, payload, env, timeoutMs, stageLabel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const bodyStr = JSON.stringify(payload);

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
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const label = stageLabel ? `[${stageLabel}, 요청 바디 ${bodyStr.length}자] ` : '';
    throw new Error(label + 'Groq API 응답 실패: HTTP ' + res.status + ' ' + errBody.slice(0, 300));
  }

  return res.json();
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
