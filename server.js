import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

const API_KEY = process.env.NEWS_API_KEY;

if (!API_KEY) {
  console.error("❌ API 키 없음 (.env 확인)");
  process.exit(1);
}

app.get("/news", async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/top-headlines?country=us&apiKey=${API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "서버 오류" });
  }
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}/news`);
});
