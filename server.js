import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const parser = new XMLParser();

// ✅ 안정적인 RSS (CNBC)
const RSS_FEEDS = [
  "https://www.cnbc.com/id/100003114/device/rss/rss.html"
];

app.get("/news", async (req, res) => {
  try {
    // ✅ 1. API 키 체크
    if (!NEWS_API_KEY || !OPENAI_API_KEY) {
      return res.json({ error: "API 키 누락" });
    }

    // ✅ 2. NewsAPI (business)
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${NEWS_API_KEY}`;
    const newsRes = await fetch(newsUrl);
    const newsData = await newsRes.json();

    // ✅ 3. RSS 가져오기 (CNBC)
    const rssResponses = await Promise.all(
      RSS_FEEDS.map(url => fetch(url).then(res => res.text()))
    );

    let rssArticles = [];

    rssResponses.forEach(text => {
      const parsed = parser.parse(text);
      const items = parsed.rss.channel.item;

      items.forEach(item => {
        rssArticles.push({
          title: item.title,
          description: item.description,
          content: item.description,
          source: { name: "CNBC" }
        });
      });
    });

    // ✅ 4. 합치기
    const allArticles = [...newsData.articles, ...rssArticles];

    // ✅ 5. 중복 제거 (제목 기준)
    const uniqueMap = new Map();
    allArticles.forEach(article => {
      if (article.title) {
        uniqueMap.set(article.title, article);
      }
    });
    const uniqueArticles = Array.from(uniqueMap.values());

    // ✅ 6. 필터링 (최종 버전)
    const trustedArticles = uniqueArticles.filter(article => {
      const name = article.source.name?.toLowerCase() || "";

      // ❌ 차단
      if (
        name.includes("gsmarena") ||
        name.includes("japan times") ||
        name.includes("sports") ||
        name.includes("entertainment")
      ) {
        return false;
      }

      // ✅ 허용
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

    if (trustedArticles.length === 0) {
      return res.json({
        error: "신뢰 뉴스 없음"
      });
    }

    // ✅ 7. 최대 10개 사용
    const finalArticles = trustedArticles.slice(0, 10);

    const content = finalArticles.map(a => `
제목: ${a.title}
설명: ${a.description}
출처: ${a.source.name}
`).join("\n\n");

    // ✅ 8. GPT 분석
    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
추측 금지, 기사 기반 사실만 사용.
`
          },
          {
            role: "user",
            content: `
다음 뉴스 분석:

1. 핵심 뉴스 3개
2. 시장 영향
3. 주목 섹터

${content}
`
          }
        ]
      })
    });

    const gptData = await gptRes.json();

    if (!gptData.choices) {
      return res.json({
        error: "GPT 오류",
        detail: gptData
      });
    }

    res.json({
      total_articles: allArticles.length,
      trusted_articles: trustedArticles.length,
      analysis: gptData.choices[0].message.content
    });

  } catch (err) {
    res.json({
      error: "서버 오류",
      message: err.message
    });
  }
});

// 상태 확인
app.get("/", (req, res) => {
  res.send("✅ RSS Stable Server Running");
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
