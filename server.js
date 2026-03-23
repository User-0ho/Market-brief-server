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

// ✅ fetch timeout
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

// ✅ STEP2 키워드 정의
const keywords = [
  "inflation",
  "interest rate",
  "fed",
  "oil",
  "recession",
  "economy",
  "earnings",
  "AI",
  "semiconductor",
  "geopolitics"
];

// ✅ 리포트 생성
async function generateReport(trigger = "manual") {
  let reportText = "";

  try {
    // =========================
    // STEP1: 뉴스 필터링
    // =========================
    const trustedSources = [
      "Reuters",
      "Bloomberg",
      "CNBC",
      "Financial Times",
      "BBC News",
      "The Wall Street Journal",
      "Associated Press"
    ];

    const newsUrl = `https://newsapi.org/v2/everything?q=(stock OR inflation OR interest rate OR oil OR fed OR economy)&language=en&sortBy=publishedAt&pageSize=30&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = await newsRes?.json();

    let articles = newsData?.articles || [];

    let filteredArticles = articles.filter(a =>
      trustedSources.includes(a.source.name)
    );

    if (filteredArticles.length < 5) {
      console.log("⚠️ 신뢰 뉴스 부족 → fallback");
      filteredArticles = articles.slice(0, 15);
    }

    // =========================
    // STEP2: 이슈 클러스터링
    // =========================
    const keywordCount = {};

    keywords.forEach(k => (keywordCount[k] = 0));

    filteredArticles.forEach(article => {
      const text = (article.title + " " + article.description).toLowerCase();

      keywords.forEach(keyword => {
        if (text.includes(keyword)) {
          keywordCount[keyword]++;
        }
      });
    });

    // 빈도 정렬
    const sortedKeywords = Object.entries(keywordCount)
      .sort((a, b) => b[1] - a[1])
      .filter(k => k[1] > 0);

    // 상위 3개 이슈
    const topIssues = sortedKeywords.slice(0, 3);

    console.log("🔥 핵심 이슈:", topIssues);

    // =========================
    // GPT 입력 구조 변경
    // =========================
    const issueSummary = topIssues
      .map(([k, v]) => `${k} (${v}회 언급)`)
      .join("\n");

    const content = filteredArticles.slice(0, 5).map(a => `
제목: ${a.title}
출처: ${a.source.name}
`).join("\n\n");

    // =========================
    // GPT 분석
    // =========================
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
너는 기관 투자자 수준의 미국 주식 애널리스트다.

반드시 아래 규칙을 따른다:
- 반복적으로 등장한 핵심 이슈만 기반으로 분석
- 단일 뉴스는 무시
- 시장 방향성(Bull / Neutral / Bear)을 판단
- 섹터 영향 포함
- 추측 금지
`
              },
              {
                role: "user",
                content: `
핵심 이슈:
${issueSummary}

참고 뉴스:
${content}

다음을 분석:

1. 핵심 매크로 요약
2. 시장 방향성 (Bull / Neutral / Bear)
3. 섹터 영향 (상승 / 하락)
4. 투자 전략
`
              }
            ]
          })
        },
        30000
      );

      const gptData = await gptRes?.json();

      console.log("🧠 GPT 응답:", JSON.stringify(gptData, null, 2));

      reportText = gptData?.choices?.[0]?.message?.content;

    } catch (err) {
      console.log("❌ GPT 실패:", err.message);
    }

    // fallback
    if (!reportText) {
      reportText = "⚠️ 분석 실패 (fallback)";
    }

    const id = new Date().toISOString();

    const newReport = {
      id,
      createdAt: new Date(),
      report: reportText,
      views: 0,
      trigger
    };

    reports[id] = newReport;

    console.log("✅ 리포트 생성:", id);

    return newReport;

  } catch (err) {
    console.log("❌ 전체 실패:", err.message);
  }
}

// API
app.get("/news/generate", async (req, res) => {
  const result = await generateReport("manual");
  res.json(result);
});

app.get("/news/latest", (req, res) => {
  const keys = Object.keys(reports);
  const latest = reports[keys[keys.length - 1]];
  res.json(latest);
});

// cron
cron.schedule("0 6 * * *", () => generateReport("morning"));
cron.schedule("0 21 * * *", () => generateReport("evening"));

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
