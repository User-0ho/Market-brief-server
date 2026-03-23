import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let reports = {};

// ✅ CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

// ✅ fetch timeout (30초)
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    console.log("❌ fetch 실패:", err.message);
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ✅ 리포트 생성
async function generateReport(trigger = "manual") {
  let reportText = "";

  try {
    // 🔥 STEP1: 기관급 뉴스 수집 + 필터링

    const trustedSources = [
      "Reuters",
      "Bloomberg",
      "CNBC",
      "Financial Times",
      "BBC News",
      "The Wall Street Journal",
      "Associated Press"
    ];

    const newsUrl = `https://newsapi.org/v2/everything?q=(stock OR inflation OR interest rate OR oil OR fed OR economy)&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = await newsRes?.json();

    let articles = newsData?.articles || [];

    // ✅ 신뢰도 필터링
    let filteredArticles = articles.filter(a =>
      trustedSources.includes(a.source.name)
    );

    // ✅ fallback (뉴스 부족 시 일부 허용)
    if (filteredArticles.length < 5) {
      console.log("⚠️ 신뢰 뉴스 부족 → 일부 일반 뉴스 포함");
      filteredArticles = articles.slice(0, 10);
    } else {
      filteredArticles = filteredArticles.slice(0, 10);
    }

    console.log("📰 최종 기사 수:", filteredArticles.length);
    console.log("📰 출처:", filteredArticles.map(a => a.source.name));

    const content = filteredArticles.map(a => `
제목: ${a.title}
설명: ${a.description}
출처: ${a.source.name}
`).join("\n\n");

    // 2️⃣ GPT 분석
    try {
      const gptRes = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `
너는 미국 주식 애널리스트다.
여러 기사에서 공통적으로 반복되는 핵심 이슈만 기반으로 분석하라.
추측 금지.
`
              },
              {
                role: "user",
                content: `
다음 뉴스들을 분석:

1. 핵심 뉴스 3개
2. 시장 영향
3. 투자 관점 요약

${content}
`
              }
            ]
          })
        },
        30000
      );

      const gptData = await gptRes?.json();

      console.log("🧠 GPT 응답:", JSON.stringify(gptData, null, 2));

      if (!gptRes || !gptRes.ok) {
        console.log("❌ OpenAI 상태:", gptRes?.status);
        console.log("❌ OpenAI 에러:", gptData);
      }

      reportText = gptData?.choices?.[0]?.message?.content;

    } catch (err) {
      console.log("❌ GPT 실패:", err.message);
    }

    // 3️⃣ fallback
    if (!reportText) {
      reportText = `
[임시 리포트 - 시스템 fallback]

현재 AI 분석이 정상적으로 생성되지 않았습니다.

📌 수집된 뉴스:
${content || "뉴스 데이터 없음"}

⚠️ 이후 자동 복구됩니다.
`;
    }

    // 4️⃣ 저장
    const id = new Date().toISOString();

    const newReport = {
      id,
      createdAt: new Date(),
      report: reportText,
      views: 0,
      trigger
    };

    reports[id] = newReport;

    console.log(`✅ 리포트 생성 (${trigger}):`, id);

    return newReport;

  } catch (err) {
    console.log("❌ 전체 실패:", err.message);

    const id = new Date().toISOString();

    const fallback = {
      id,
      createdAt: new Date(),
      report: "⚠️ 시스템 오류로 리포트 생성 실패",
      views: 0,
      trigger
    };

    reports[id] = fallback;

    return fallback;
  }
}

// ✅ 수동 생성
app.get("/news/generate", async (req, res) => {
  const result = await generateReport("manual");
  res.json(result);
});

// ✅ cron 자동화
cron.schedule("0 6 * * *", () => {
  console.log("⏰ 06:00 자동 실행");
  generateReport("morning");
});

cron.schedule("0 21 * * *", () => {
  console.log("⏰ 21:00 자동 실행");
  generateReport("evening");
});

// ✅ 최신 리포트
app.get("/news/latest", (req, res) => {
  const keys = Object.keys(reports);

  if (keys.length === 0) {
    return res.json({
      error: "리포트 없음",
      message: "아직 생성된 리포트가 없습니다"
    });
  }

  const latest = reports[keys[keys.length - 1]];
  latest.views++;

  res.json(latest);
});

// ✅ 히스토리
app.get("/news/history", (req, res) => {
  res.json(Object.values(reports));
});

// ✅ 상태 확인
app.get("/", (req, res) => {
  res.send("✅ AI Market Report Cron Server Running");
});

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
