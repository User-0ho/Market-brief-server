import express from "express";
import fetch from "node-fetch";
import Parser from "rss-parser";

const app = express();
const parser = new Parser();

const PORT = process.env.PORT || 3000;

app.get("/market-brief", async (req, res) => {
  const NEWS_API_KEY = "여기에_뉴스API키";

  try {
    // -------------------------
    // 1️⃣ RSS (BBC로 변경 - 안정적)
    // -------------------------
    const feed = await parser.parseURL(
      "https://feeds.bbci.co.uk/news/business/rss.xml"
    );

    const rssArticles = feed.items.map(item => ({
      title: item.title,
      source: "BBC",
      link: item.link,
      pubDate: item.pubDate
    }));

    // -------------------------
    // 2️⃣ NewsAPI
    // -------------------------
    const newsRes = await fetch(
      `https://newsapi.org/v2/top-headlines?country=us&category=business&pageSize=10&apiKey=${NEWS_API_KEY}`
    );

    const newsData = await newsRes.json();

    const newsArticles = (newsData.articles || []).map(a => ({
      title: a.title,
      source: a.source.name,
      url: a.url,
      publishedAt: a.publishedAt
    }));

    // -------------------------
    // 3️⃣ GDELT
    // -------------------------
    const gdeltRes = await fetch(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=stock%20market&mode=ArtList&maxrecords=10&format=json"
    );

    const gdeltData = await gdeltRes.json();

    const gdeltArticles = (gdeltData.articles || []).map(a => ({
      title: a.title,
      source: a.source,
      url: a.url,
      publishedAt: a.seendate
    }));

    // -------------------------
    // 4️⃣ 데이터 합치기
    // -------------------------
    const combined = [
      ...rssArticles,
      ...newsArticles,
      ...gdeltArticles
    ];

    // -------------------------
    // 5️⃣ 신뢰 매체 필터
    // -------------------------
    const TRUSTED = [
      "Reuters",
      "BBC",
      "Associated Press",
      "CNBC",
      "Yahoo",
      "MarketWatch"
    ];

    const filtered = combined.filter(a =>
      TRUSTED.some(t =>
        (a.source || "").toLowerCase().includes(t.toLowerCase())
      )
    );

    // -------------------------
    // 6️⃣ 결과 반환
    // -------------------------
    res.json({
      market_status: {
        session: "unknown",
        note: "초기 버전"
      },
      main_articles: filtered.slice(0, 3),
      impact_articles: filtered.slice(3, 8)
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
