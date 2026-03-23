import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const parser = new XMLParser();

// 🔥 저장소
let reports = {};

// ✅ CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

// 🔥 fetch timeout
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// 🔥 리포트 생성 함수
async function generateReport() {
  try {
    if (!NEWS_API_KEY || !OPENAI_API_KEY) return;

    const newsUrl = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${NEWS_API_KEY}`;
    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = await newsRes.json();

    if (!newsData.articles) return;

    const content = newsData.articles.slice(0, 10).map(a => `
제목: ${a.title}
설명: ${a.description}
출처: ${a.source.name}
`).join("\n\n");

    const gptRes = await fetchWithTimeout(
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
너는 미국 주식 애널리스트다.
공통 뉴스 기반으로 분석하라.
`
            },
            {
              role: "user",
              content: `
[오늘의 시장 리포트]
${content}
`
            }
          ]
        })
      }
    );

    const gptData = await gptRes.json();
    const reportText = gptData?.choices?.[0]?.message?.content;

    if (!reportText) return;

    const id = new Date().toISOString();

    reports[id] = {
      id,
      createdAt: new Date(),
      report: reportText,
      views: 0
    };

    console.log("✅ 리포트 생성:", id);

  } catch (err) {
    console.log("❌ 생성 실패:", err.message);
  }
}

// 🔥 수동 생성 (테스트용)
app.get("/news/generate", async (req, res) => {
  await generateReport();
  res.json({ message: "리포트 생성 완료" });
});

// 🔥 자동 생성 (1시간 체크)
setInterval(() => {
  const now = new Date();
  const hour = now.getHours();

  if (hour === 21 || hour === 6) {
    generateReport();
  }
}, 60 * 60 * 1000);

// 🔥 30일 자동 삭제
setInterval(() => {
  const now = new Date();

  Object.keys(reports).forEach(id => {
    const age = (now - new Date(reports[id].createdAt)) / (1000 * 60 * 60 * 24);

    if (age > 30) {
      delete reports[id];
      console.log("🗑 삭제:", id);
    }
  });

}, 6 * 60 * 60 * 1000);

// 🔥 압축 함수
function compressReport(text, level) {
  if (level === "mid") return text.split("\n").slice(0, 10).join("\n");
  if (level === "low") return text.split("\n").slice(0, 5).join("\n");
  return text;
}

// 📌 최신
app.get("/news/latest", (req, res) => {
  const keys = Object.keys(reports);
  if (keys.length === 0) return res.json({ error: "리포트 없음" });

  const latest = reports[keys[keys.length - 1]];
  latest.views++;

  res.json(latest);
});

// 📌 목록
app.get("/news/history", (req, res) => {
  res.json(Object.values(reports));
});

// 📌 상세
app.get("/news/:id", (req, res) => {
  const report = reports[req.params.id];
  if (!report) return res.json({ error: "없음" });

  const now = new Date();
  const age = (now - new Date(report.createdAt)) / (1000 * 60 * 60 * 24);

  let level = "full";
  if (age > 7) level = "low";
  else if (age > 3) level = "mid";

  report.views++;

  res.json({
    ...report,
    report: compressReport(report.report, level),
    level
  });
});

// 📌 루트
app.get("/", (req, res) => {
  res.send("AI Market Report Server Running");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
