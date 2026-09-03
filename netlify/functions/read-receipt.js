// Netlify Function: 정산표 사진을 Claude Vision으로 읽어서 숫자를 뽑아줘요.
// 이 파일은 서버(넷리파이) 쪽에서만 실행돼요. API 키가 여기 있어도
// 사용자 브라우저에는 절대 노출되지 않아요.

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

  const { base64Data, mediaType } = body;
  if (!base64Data || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "이미지 데이터가 없어요." }) };
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
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: "너는 한국 식당·주점 POS기의 '영업 마감 내역' 정산표 사진에서 숫자를 정확히 읽어내는 도구야. 이 정산표는 보통 이런 항목들을 포함해: 총매출액(총 결제 건수와 금액), 할인금액, 순매출액, 신용카드(건수+금액), 현금(건수+금액), 시재. 반드시 JSON 객체만 응답해, 다른 설명이나 마크다운 코드블럭 없이. 각 필드는 다음 중 사진에서 명확히 확인되는 값만 숫자(콤마·원 표시 없이 순수 정수)로 채우고, 사진에 없거나 흐릿해서 확신이 안 서면 null로 남겨: totalSales(총매출액), discount(할인금액), refund(반품금액), cashSales(현금 항목의 금액, '현금비매출'이 아니라 '영업매출내역'의 현금), cardSales(신용카드 금액), till(시재). 추측하지 말고 안 보이면 null.",
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: "이 정산표 사진에서 위에 설명한 필드들을 JSON으로 뽑아줘." }
          ]
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
    if (!textBlock) {
      return { statusCode: 200, body: JSON.stringify({ result: null }) };
    }

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 200, body: JSON.stringify({ result: null }) };
    }

    return { statusCode: 200, body: JSON.stringify({ result: parsed }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "서버 오류가 발생했어요." }) };
  }
};
