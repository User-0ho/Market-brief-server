import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.NEWS_API_KEY;

app.get("/news", async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/top-headlines?country=us&apiKey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log("server running");
});
