// Netlify Function: 사장님/본사가 물어보는 질문에, 앱에 있는 실제 데이터를 바탕으로 답해줘요.
// 조회(읽기)만 하는 용도예요 — 이 함수는 데이터베이스에 아무것도 쓰거나 지우지 않아요.

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

  const { question, context } = body;
  if (!question || !context) {
    return { statusCode: 400, body: JSON.stringify({ error: "질문이나 데이터가 없어요." }) };
  }

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
        max_tokens: 400,
        system: "너는 한국 외식업 매장 관리 앱의 데이터 비서야. 아래 JSON으로 주어지는 실제 매장 데이터만 근거로 질문에 답해. 데이터에 없는 내용은 추측하지 말고 '그 정보는 지금 데이터에 없어요'라고 말해. 절대 데이터를 바꾸거나 실행하는 액션은 하지 말고, 오직 정보 조회 답변만 해. 답변은 한국어로 짧고 자연스럽게, 존댓말로.",
        messages: [{
          role: "user",
          content: "매장 데이터:\n" + JSON.stringify(context) + "\n\n질문: " + question
        }]
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
    const answer = textBlock ? textBlock.text : "답변을 만들지 못했어요.";

    return { statusCode: 200, body: JSON.stringify({ answer }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "서버 오류가 발생했어요." }) };
  }
};
