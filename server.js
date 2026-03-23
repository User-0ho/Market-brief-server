import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 👉 신뢰 매체 리스트
const TRUSTED_SOURCES = [
  "Reuters",
  "Bloomberg",
  "Wall Street Journal",
  "Financial Times",
  "CNBC"
];

app.get("/news", async (req, res) => {
  try {
    // 1️⃣ 뉴스 가져오기
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&apiKey=${NEWS_API_KEY}`;
    const newsResponse = await fetch(newsUrl);
    const newsData = await newsResponse.json();

    // 2️⃣ 신뢰 매체 필터링
    const trustedArticles = newsData.articles.filter(article =>
      TRUSTED_SOURCES.some(source =>
        article.source.name?.includes(source)
      )
    );

    const finalArticles = trustedArticles.length > 0 ? trustedArticles : newsData.articles;

    // 3️⃣ 제목 + 설명 + 내용 일부 포함
    const content = finalArticles
      .map(a => `
제목: ${a.title}
설명: ${a.description}
내용: ${a.content || ""}
출처: ${a.source.name}
`)
      .join("\n\n");

    // 4️⃣ GPT 요청 (🔥 신뢰도 강화 프롬프트)
    const gptResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content: `
너는 미국 주식 투자자를 위한 금융 뉴스 분석가다.

반드시 지켜야 할 규칙:
1. 기사에 없는 내용은 절대 추가하지 마라
2. 추측, 가정, 과장 금지
3. 확인된 사실만 기반으로 분석
4. 출처가 불명확한 정보는 제외
5. 금융 시장 영향 중심으로 분석
`
            },
            {
              role: "user",
              content: `
다음 뉴스들을 기반으로 분석해라.

[출력 형식]
1. 핵심 뉴스 3개
2. 시장 영향
3. 주목할 섹터

뉴스:
${content}
`
            }
          ],
        }),
      }
    );

    const gptData = await gptResponse.json();

    res.json({
      total_articles: newsData.articles.length,
      trusted_articles: finalArticles.length,
      analysis: gptData.choices[0].message.content
    });

  } catch (error) {
    console.error("❌ 서버 오류:", error);
    res.status(500).json({ error: "서버 오류 발생" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
