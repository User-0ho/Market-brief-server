import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

    // ✅ 2. 뉴스 가져오기 (🔥 business만)
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${NEWS_API_KEY}`;
    const newsResponse = await fetch(newsUrl);
    const newsData = await newsResponse.json();

    if (!newsData.articles) {
      return res.json({
        error: "NewsAPI 응답 오류",
        detail: newsData
      });
    }

    // ✅ 3. 🔥 강제 신뢰 매체 필터링 (핵심)
    const trustedArticles = newsData.articles.filter(article => {
      const name = article.source.name?.toLowerCase() || "";

      return (
        name.includes("reuters") ||
        name.includes("bloomberg") ||
        name.includes("wall street journal") ||
        name.includes("financial times") ||
        name.includes("cnbc") ||
        name.includes("associated press") ||
        name.includes("ap news")
      );
    });

    // ❗ 신뢰 뉴스 없으면 분석 안 함
    if (trustedArticles.length === 0) {
      return res.json({
        error: "신뢰할 수 있는 뉴스 없음",
        message: "현재 주요 매체 뉴스가 부족합니다. 잠시 후 다시 시도하세요."
      });
    }

    const finalArticles = trustedArticles;

    // ✅ 4. 뉴스 데이터 구성 (최대 10개)
    const content = finalArticles
      .slice(0, 10)
      .map(a => `
제목: ${a.title}
설명: ${a.description}
내용: ${a.content || ""}
출처: ${a.source.name}
`)
      .join("\n\n");

    // ✅ 5. GPT 요청
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
- 기사에 없는 내용 절대 추가 금지
- 추측, 과장 금지
- 사실 기반만 사용
- 시장 영향 중심 분석
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

    // ✅ 6. GPT 응답 검증
    if (!gptData.choices) {
      return res.json({
        error: "GPT 응답 실패",
        detail: gptData
      });
    }

    // ✅ 7. 정상 결과
    res.json({
      total_articles: newsData.articles.length,
      trusted_articles: finalArticles.length,
      analysis: gptData.choices[0].message.content
    });

  } catch (error) {
    console.error("🔥 서버 에러:", error);

    res.json({
      error: "서버 내부 오류",
      message: error.message
    });
  }
});

// ✅ 서버 상태 확인용
app.get("/", (req, res) => {
  res.send("✅ Market Brief Server Running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
