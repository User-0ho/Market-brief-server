import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/news", async (req, res) => {
  try {
    // 1️⃣ 뉴스 가져오기
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&apiKey=${NEWS_API_KEY}`;
    const newsResponse = await fetch(newsUrl);
    const newsData = await newsResponse.json();

    // 2️⃣ 신뢰도 높은 뉴스만 필터링
    const trustedSources = ["Reuters", "Bloomberg", "Wall Street Journal"];

    const filteredArticles = newsData.articles.filter(article =>
      trustedSources.some(source =>
        article.source.name?.includes(source)
      )
    );

    // 👉 없으면 그냥 전체 사용
    const finalArticles = filteredArticles.length > 0 ? filteredArticles : newsData.articles;

    // 3️⃣ 제목 + 설명 같이 사용
    const content = finalArticles
      .map(a => `제목: ${a.title}\n내용: ${a.description}`)
      .join("\n\n");

    // 4️⃣ GPT 요청 (역할 강화)
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
              content: "너는 미국 주식 투자자를 위한 금융 뉴스 분석가다. 신뢰도 높은 정보만 기반으로 핵심 이슈와 시장 영향을 분석한다."
            },
            {
              role: "user",
              content: `다음 뉴스들을 분석해서:
1. 핵심 뉴스 3개
2. 시장 영향
3. 주목해야 할 섹터
형식으로 정리해줘:\n\n${content}`
            }
          ],
        }),
      }
    );

    const gptData = await gptResponse.json();

    res.json({
      total_articles: newsData.articles.length,
      used_articles: finalArticles.length,
      analysis: gptData.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "서버 오류" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
