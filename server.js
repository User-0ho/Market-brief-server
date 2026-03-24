import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const TE_API_KEY = process.env.TE_API_KEY;

let reports = {};

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

// ==================== fetch ====================
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

// ==================== GPT ====================
async function fetchGPT(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify(body)
        }
      );

      const data = await res?.json();

      if (data?.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      }

    } catch (err) {
      console.log(`❌ GPT 실패 (${i + 1})`, err.message);
    }
  }
  return null;
}

// ==================== 매크로 ====================
let macroCache = null;
let lastMacroFetch = 0;

async function getFedRate() {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=2`;

  const res = await fetchWithTimeout(url);
  const data = await res?.json();

  const latest = parseFloat(data.observations[0].value);
  const prev = parseFloat(data.observations[1].value);

  return {
    value: latest,
    trend: latest > prev ? "up" : latest < prev ? "down" : "flat"
  };
}

async function getOilPrice() {
  const url = `https://api.tradingeconomics.com/commodities?c=${TE_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = await res?.json();

  const oil = data?.find(d => d.Name === "Crude Oil WTI");

  return {
    value: oil?.Price || 75,
    change: oil?.Change || 0
  };
}

async function getMacroData() {
  if (macroCache && Date.now() - lastMacroFetch < 10 * 60 * 1000) {
    return macroCache;
  }

  try {
    const [rate, oil] = await Promise.all([
      getFedRate(),
      getOilPrice()
    ]);

    const macro = { rate, oil };

    macroCache = macro;
    lastMacroFetch = Date.now();

    return macro;

  } catch (err) {
    return {
      rate: { value: 5.25, trend: "flat" },
      oil: { value: 75, change: 0 }
    };
  }
}

// ==================== SPY 가격 ====================
async function getSPY() {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=SPY`;

  const res = await fetchWithTimeout(url);
  const data = await res?.json();

  const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;

  return price || null;
}

// ==================== 뉴스 중복 제거 ====================
function deduplicateArticles(articles) {
  const seen = new Set();

  return articles.filter(a => {
    const key = (a.title || "").toLowerCase().slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==================== 뉴스 sentiment ====================
function calculateSentiment(articles) {
  let score = 0;

  articles.forEach(a => {
    const text = (a.title + " " + a.description).toLowerCase();

    if (text.includes("inflation") || text.includes("rate hike")) score -= 1;
    if (text.includes("recession") || text.includes("war")) score -= 2;
    if (text.includes("growth") || text.includes("strong earnings")) score += 1;
    if (text.includes("AI boom") || text.includes("rally")) score += 2;
  });

  return score;
}

// ==================== 점수 ====================
function calculateTotalScore(macro, sentimentScore) {
  let score = 0;

  // macro
  if (macro.rate.value > 5) score -= 1;
  if (macro.rate.trend === "up") score -= 1;
  if (macro.oil.change > 1) score -= 1;

  // sentiment
  score += sentimentScore * 0.5;

  return score;
}

function scoreToSignal(score) {
  if (score <= -2) return { direction: "Bearish", prob: 65 };
  if (score >= 2) return { direction: "Bullish", prob: 65 };
  return { direction: "Neutral", prob: 55 };
}

// ==================== 리포트 ====================
async function generateReport(trigger = "manual") {
  try {
    const trustedSources = [
      "Reuters","Bloomberg","CNBC","Financial Times",
      "BBC News","The Wall Street Journal","Associated Press"
    ];

    const newsUrl = `https://newsapi.org/v2/everything?q=(stock OR inflation OR fed OR economy)&language=en&sortBy=publishedAt&pageSize=30&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = await newsRes?.json();

    let articles = newsData?.articles || [];

    let filteredArticles = articles.filter(a =>
      trustedSources.includes(a.source.name)
    );

    filteredArticles = deduplicateArticles(filteredArticles);

    if (filteredArticles.length < 5) {
      filteredArticles = articles.slice(0, 15);
    }

    const rawNews = filteredArticles
      .slice(0, 10)
      .map(a => a.title + " " + a.description)
      .join("\n");

    const structuredIssues = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "핵심 매크로 이슈 3개 요약" },
        { role: "user", content: rawNews }
      ]
    });

    const macro = await getMacroData();
    const spy = await getSPY();
    const sentimentScore = calculateSentiment(filteredArticles);

    const totalScore = calculateTotalScore(macro, sentimentScore);
    const signal = scoreToSignal(totalScore);

    const reportText = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "정량 신호를 변경하지 말고 해석만 수행"
        },
        {
          role: "user",
          content: `
이슈:
${structuredIssues}

SPY: ${spy}
금리: ${macro.rate.value} (${macro.rate.trend})
유가: ${macro.oil.value}

뉴스 sentiment 점수: ${sentimentScore}

최종 신호:
${signal.direction} (${signal.prob}%)

분석 작성
`
        }
      ]
    });

    const id = new Date().toISOString();

    reports[id] = {
      id,
      createdAt: new Date(),
      report: reportText,
      signal,
      spy,
      sentimentScore,
      totalScore,
      trigger
    };

    return reports[id];

  } catch (err) {
    console.log(err);
    return { report: "⚠️ 오류" };
  }
}

// ==================== API ====================
app.get("/news/generate", async (req, res) => {
  res.json(await generateReport());
});

app.get("/news/latest", (req, res) => {
  const keys = Object.keys(reports);
  res.json(reports[keys[keys.length - 1]]);
});

// ==================== cron ====================
cron.schedule("0 6 * * *", () => generateReport("morning"));
cron.schedule("0 21 * * *", () => generateReport("evening"));

app.listen(PORT, () => {
  console.log("🚀 Server running");
});
