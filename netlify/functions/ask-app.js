// Netlify Function: 사장님/본사가 물어보는 질문에 답하거나(조회),
// 스케줄 등록/공지 작성/거래처 추가 같은 가벼운 작업을 "확인 후 실행"할 수 있게 도와줘요.
// 이 함수 자체는 데이터베이스에 아무것도 쓰지 않아요 — 실행 여부는 클라이언트(앱)에서 사람이 확인 버튼을 눌러야 실제로 반영돼요.

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "서버에 ANTHROPIC_API_KEY 환경변수가 설정되지 않았어요." })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "잘못된 요청이에요." }) };
  }

  const { messages, context } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0 || !context) {
    return { statusCode: 400, body: JSON.stringify({ error: "질문이나 데이터가 없어요." }) };
  }

  const todayStr = context.today || "";

  const systemPrompt = `너는 한국 외식업 매장 관리 앱의 데이터 비서야. 아래 JSON으로 주어지는 실제 매장 데이터(이번 달 + 지난 몇 달 요약)만 근거로 대화에 답해. 데이터에 없는 내용은 추측하지 말고 데이터에 없다고 말해.

오늘 날짜: ${todayStr}

반드시 아래 두 형식 중 하나로만, 다른 설명 없이 순수 JSON 객체로만 응답해:

1) 질문에 답하는 경우:
{"type":"answer","text":"자연스러운 한국어 답변, 존댓말로 짧게"}

2) 사용자가 아래 세 가지 중 하나를 실행해달라고 명확히 요청한 경우만:
- 스케줄(근무) 등록: {"type":"action","actionType":"add_shift","params":{"crewName":"이름","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM"},"confirmText":"자연스러운 확인 문구, 예: 김지현님을 9월 9일 10:00~18:00로 등록할까요?"}
- 공지사항 작성: {"type":"action","actionType":"add_announcement","params":{"title":"제목","body":"내용"},"confirmText":"..."}
- 거래처 추가: {"type":"action","actionType":"add_vendor","params":{"name":"거래처명"},"confirmText":"..."}

주의사항:
- 매출보고 작성/수정, 급여·계좌번호·주민번호 같은 민감정보 수정, 출퇴근 기록 삭제/확정, 지출 항목 추가/삭제는 절대 action으로 만들지 마. 이런 요청이 오면 "이 작업은 직접 화면에서 진행해 주셔야 해요"라고 answer로 안내해.
- 날짜를 상대적으로 말하면(내일, 다음 주 화요일 등) 오늘 날짜를 기준으로 정확한 YYYY-MM-DD로 계산해.
- 필요한 정보(이름, 날짜, 시간 등)가 부족하면 action이 아니라 answer로 부족한 정보를 되물어.
- 데이터에 없는 스텝 이름을 말하면 action을 만들지 말고 answer로 그런 스텝이 없다고 알려줘.`;

  const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
  apiMessages.unshift({ role: "user", content: "매장 데이터:\n" + JSON.stringify(context) });
  apiMessages.push({ role: "assistant", content: "알겠습니다, 이후 질문에 위 JSON 형식으로만 답할게요." });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: apiMessages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "Anthropic API 오류", detail: data })
      };
    }

    const textBlock = (data.content || []).find(b => b.type === "text");
    const raw = textBlock ? textBlock.text.replace(/```json|```/g, "").trim() : "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { type: "answer", text: raw || "답변을 만들지 못했어요." };
    }

    return { statusCode: 200, body: JSON.stringify({ result: parsed }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "서버 오류가 발생했어요." }) };
  }
};
