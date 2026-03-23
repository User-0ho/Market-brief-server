import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const parser = new XMLParser();


// ✅🔥 CORS 해결 (이거 핵심)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});


// ✅ CNBC RSS
const RSS_FEEDS = [
  "https://www.cnbc.com/id/100003114/device/rss/rss.html"
];


app.get("/news", async (req, res) => {
  try {
    if (!NEWS_API_KEY || !OPENAI_API_KEY) {
      return res.json({ error: "API 키 누락" });
    }

    // 1️⃣ NewsAPI
    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${NEWS_API_KEY}`;
    const newsRes = await fetch(newsUrl);
    const newsData = await newsRes.json();

    // 2️⃣ RSS
    const rssResponses = await Promise.all(
      RSS_FEEDS.map(url => fetch(url).then(res => res.text()))
    );

    let rssArticles = [];

    rssResponses.forEach(text => {
      const parsed = parser.parse(text);
      const items = parsed.rss.channel.item || [];

      items.forEach(item => {
        rssArticles.push({
          title: item.title,
          description: item.description,
          content: item.description,
          source: { name: "CNBC" }
        });
      });
    });

    // 3️⃣ 통합
    const allArticles = [...newsData.articles, ...rssArticles];

    // 4️⃣ 중복 제거
    const uniqueMap = new Map();
    allArticles.forEach(article => {
      if (article.title) {
        uniqueMap.set(article.title, article);
      }
    });
    const uniqueArticles = Array.from(uniqueMap.values());

    // 5️⃣ 필터링
    const trustedArticles = uniqueArticles.filter(article => {
      const name = article.source.name?.toLowerCase() || "";

      if (
        name.includes("gsmarena") ||
        name.includes("japan times") ||
        name.includes("sports") ||
        name.includes("entertainment")
      ) {
        return false;
      }

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
      return res.json({ error: "신뢰 뉴스 없음" });
    }

    // 6️⃣ 최대 10개
    const finalArticles = trustedArticles.slice(0, 10);

    const content = finalArticles.map(a => `
제목: ${a.title}
설명: ${a.description}
출처: ${a.source.name}
`).join("\n\n");

    // 7️⃣ GPT 분석
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
너는 미국 주식 투자 전문 애널리스트다.
기사 기반 사실만 사용하고 추측은 금지한다.
`
          },
          {
            role: "user",
            content: `
다음 뉴스들을 분석해서 작성:

[오늘의 시장 리포트]

1. 핵심 뉴스 3개
2. 시장 영향

[투자 신호]
- 시장 방향 (상승/하락/중립 + 확률)
- 상승 가능 섹터 3개
- 주의 섹터 2개

뉴스:
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
      report: gptData.choices[0].message.content
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
  res.send("✅ AI Market Report Server Running");
});


app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
