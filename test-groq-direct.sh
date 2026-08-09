#!/bin/bash
# ─────────────────────────────────────────────────────────
# Groq API를 Worker 없이 "직접" 호출해서 413이
#   (A) Groq API/계정 자체의 문제인지
#   (B) Worker 배포/캐시 문제인지
# 를 격리해서 확인하는 테스트 스크립트입니다.
#
# 사용법:
   GROQ_API_KEY="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" bash test-groq-direct.sh
# ─────────────────────────────────────────────────────────

if [ -z "$GROQ_API_KEY" ]; then
  echo "❌ 환경변수 GROQ_API_KEY를 설정해주세요."
  echo "   예: GROQ_API_KEY=gsk_xxxxx bash test-groq-direct.sh"
  exit 1
fi

echo "── 테스트 1: 아주 짧은 요청 (10자 미만) ──"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" \
  https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{
    "model": "groq/compound",
    "messages": [{"role": "user", "content": "안녕"}]
  }'

echo ""
echo "── 테스트 2: search_settings 포함 (실제 Worker 1단계와 동일한 형태) ──"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" \
  https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{
    "model": "groq/compound",
    "messages": [{"role": "user", "content": "다음 주제에 대해 최신 웹 정보를 검색하고, 핵심 사실 위주로 간결하게 정리해줘. 블로그 글/이미지 제작에 참고할 자료 수집이 목적이므로 과장 없이 사실만 나열해줘.\n\n주제: 테스트 주제입니다"}],
    "search_settings": {"country": "south korea"}
  }'

echo ""
echo "── 테스트 3: 요청 헤더/바디 크기 직접 출력 ──"
BODY='{"model":"groq/compound","messages":[{"role":"user","content":"테스트"}]}'
echo "바디 크기(바이트): $(echo -n "$BODY" | wc -c)"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -v \
  https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d "$BODY" 2>&1 | grep -E "HTTP_STATUS|< HTTP|error"

echo ""
echo "── 결과 해석 ──"
echo "테스트 1/2 모두 413이 나면 → Groq API 키/계정/조직 설정 자체의 문제입니다."
echo "  (예: 키가 잘못됨, 조직 결제 상태 문제, Groq 쪽 임시 장애 등)"
echo "  → Groq 콘솔(https://console.groq.com)에서 키 상태와 사용량 확인 필요"
echo ""
echo "테스트 1/2 모두 200이면 → Groq 자체는 정상이며, 문제는 Worker 쪽입니다."
echo "  → Cloudflare 대시보드에서 aibp-search-grounding-groq Worker가"
echo "    실제로 최신 코드로 재배포됐는지, GROQ_API_KEY secret이"
echo "    올바른 값으로 설정돼 있는지 다시 확인해주세요."
