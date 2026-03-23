import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TRUSTED_SOURCES = [
  "Reuters",
  "Bloomberg",
  "Wall Street Journal",
  "Financial Times",
  "CNBC"
];

app.get("/news", async (req, res) => {
  try {
    // ✅ 1. API 키 체크
    if (!NEWS_API_KEY || !OPENAI_API_KEY) {
      return res.json({
        error: "API 키 누락",
        detail: {
          NEWS_API_KEY: !!NEWS_API_KEY,
          OPENAI_API_KEY: !!OPENAI_API_KEY
        }
      });
    }

    // ✅ 2. 뉴스 가져오기
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&apiKey=${NEWS_API_KEY}`;
    const newsResponse = await fetch(newsUrl);
    const newsData = await newsResponse.json();

    if (!newsData.articles) {
      return res.json({
        error: "NewsAPI 응답 오류",
        detail: newsData
      });
    }

    // ✅ 3. 신뢰 매체 필터링
    const trustedArticles = newsData.articles.filter(article =>
      TRUSTED_SOURCES.some(source =>
        article.source.name?.includes(source)
      )
    );

    const finalArticles = trustedArticles.length > 0
      ? trustedArticles
      : newsData.articles;

    // ✅ 4. 뉴스 데이터 구성
    const content = finalArticles
      .slice(0, 10) // 🔥 토큰 과다 방지 (중요)
      .map(a => `
제목: ${a.title}
설명: ${a.description}
내용: ${a.content || ""}
출처: ${a.source.name}
`)
      .join("\n\n");

    // ✅ 5. GPT 호출
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
너는 금융 뉴스 분석가다.

규칙:
- 추측 금지
- 기사 기반 사실만 사용
- 없는 정보 생성 금지
`
            },
            {
              role: "user",
              content: `
다음 뉴스들을 분석해라.

[출력]
1. 핵심 뉴스 3개
2. 시장 영향
3. 주목 섹터

뉴스:
${content}
`
            }
          ],
        }),
      }
    );

    const gptData = await gptResponse.json();

    // ✅ 6. GPT 에러 처리 (🔥 핵심)
    if (!gptData.choices) {
      return res.json({
        error: "GPT 응답 실패",
        detail: gptData
      });
    }

    // ✅ 7. 정상 결과
    res.json({
      total_articles: newsData.articles.length,
      used_articles: finalArticles.length,
      analysis: gptData.choices[0].message.content
    });

  } catch (error) {
    console.error("🔥 서버 에러:", error);

    // ✅ 절대 서버 안 죽게
    res.json({
      error: "서버 내부 오류",
      message: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("✅ Market Brief Server Running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
