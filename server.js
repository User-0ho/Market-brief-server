import express from "express";
import fetch from "node-fetch";
import Parser from "rss-parser";

const app = express();
const parser = new Parser();

const PORT = process.env.PORT || 3000;

app.get("/market-brief", async (req, res) => {
  const NEWS_API_KEY = "여기에_뉴스API키";

  try {
    // 1️⃣ RSS (Reuters)
    const feed = await parser.parseURL(
      "http://feeds.reuters.com/reuters/businessNews"
    );

    const rssArticles = feed.items.map(item => ({
      title: item.title,
      source: "Reuters",
      link: item.link
    }));

    // 2️⃣ NewsAPI
    const newsRes = await fetch(
      `https://newsapi.org/v2/top-headlines?country=us&category=business&pageSize=10&apiKey=${NEWS_API_KEY}`
    );
    const newsData = await newsRes.json();

    const newsArticles = newsData.articles || [];

    // 3️⃣ GDELT
    const gdeltRes = await fetch(
      "https://api.gdeltproject.org/api/v2/doc/doc?query=stock%20market&mode=ArtList&maxrecords=10&format=json"
    );
    const gdeltData = await gdeltRes.json();

    const gdeltArticles = gdeltData.articles || [];

    // 4️⃣ 합치기
    const combined = [
      ...rssArticles,
      ...newsArticles,
      ...gdeltArticles
    ];

    res.json({
      main_articles: combined.slice(0, 3),
      impact_articles: combined.slice(3, 8)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
