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

// ==================== JSON 안전 파싱 ====================
async function safeJsonParse(res) {
  try {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      console.log("❌ JSON 파싱 실패:", text.slice(0, 200));
      return null;
    }
  } catch (err) {
    console.log("❌ 응답 읽기 실패:", err.message);
    return null;
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

      const data = res ? await safeJsonParse(res) : null;

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
async function getFedRate() {
  try {
    if (!FRED_API_KEY) {
      return { value: 5.25, trend: "flat" };
    }

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=2`;

    const res = await fetchWithTimeout(url);
    const data = res ? await safeJsonParse(res) : null;

    if (!data?.observations || data.observations.length < 2) {
      return { value: 5.25, trend: "flat" };
    }

    const latest = parseFloat(data.observations[0].value);
    const prev = parseFloat(data.observations[1].value);

    return {
      value: latest,
      trend: latest > prev ? "up" : latest < prev ? "down" : "flat"
    };

  } catch {
    return { value: 5.25, trend: "flat" };
  }
}

async function getOilPrice() {
  try {
    if (!TE_API_KEY) {
      return { value: 75, change: 0 };
    }

    const url = `https://api.tradingeconomics.com/commodities?c=${TE_API_KEY}`;
    const res = await fetchWithTimeout(url);
    const data = res ? await safeJsonParse(res) : null;

    if (!Array.isArray(data)) {
      return { value: 75, change: 0 };
    }

    const oil = data.find(d => d.Name === "Crude Oil WTI");

    return {
      value: oil?.Price || 75,
      change: oil?.Change || 0
    };

  } catch {
    return { value: 75, change: 0 };
  }
}

// ==================== SPY (강화 버전) ====================
async function getSPY() {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=SPY`;

    const res = await fetchWithTimeout(url);

    if (!res) return 0;

    const text = await res.text();

    if (!text.includes("quoteResponse")) {
      console.log("❌ SPY API 비정상:", text.slice(0, 100));
      return 0;
    }

    const data = JSON.parse(text);

    return data?.quoteResponse?.result?.[0]?.regularMarketPrice || 0;

  } catch (err) {
    console.log("❌ SPY 오류:", err.message);
    return 0;
  }
}

// ==================== 뉴스 필터 ====================
function isTrustedSource(name = "") {
  const lower = name.toLowerCase();
  return (
    lower.includes("reuters") ||
    lower.includes("bloomberg") ||
    lower.includes("cnbc") ||
    lower.includes("bbc") ||
    lower.includes("wsj")
  );
}

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = (a.title || "").toLowerCase().slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==================== sentiment (강화) ====================
function calculateSentiment(articles) {
  let score = 0;

  articles.forEach(a => {
    const text = ((a.title || "") + " " + (a.description || "")).toLowerCase();

    if (
      text.includes("inflation") ||
      text.includes("rate") ||
      text.includes("fed")
    ) score -= 1;

    if (
      text.includes("recession") ||
      text.includes("war") ||
      text.includes("conflict")
    ) score -= 2;

    if (
      text.includes("growth") ||
      text.includes("rally") ||
      text.includes("strong") ||
      text.includes("bull")
    ) score += 1;
  });

  return score;
}

// ==================== 점수 ====================
function calculateTotalScore(macro, sentiment) {
  let score = 0;

  if (macro.rate.value > 5) score -= 1;
  if (macro.rate.trend === "up") score -= 1;
  if (macro.oil.change > 1) score -= 1;

  score += sentiment * 0.5;

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
    const newsUrl = `https://newsapi.org/v2/everything?q=(stock OR inflation OR fed OR economy)&language=en&sortBy=publishedAt&pageSize=30&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = newsRes ? await safeJsonParse(newsRes) : null;

    let articles = newsData?.articles || [];

    let filteredArticles = articles.filter(a =>
      a?.source?.name && isTrustedSource(a.source.name)
    );

    filteredArticles = deduplicateArticles(filteredArticles);

    console.log("📰 사용 뉴스 개수:", filteredArticles.length);

    if (filteredArticles.length === 0) {
      return { report: "⚠️ 신뢰 뉴스 부족" };
    }

    const rawNews = filteredArticles
      .slice(0, 10)
      .map(a => (a.title || "") + " " + (a.description || ""))
      .join("\n");

    const structuredIssues = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "핵심 매크로 이슈 3개 요약" },
        { role: "user", content: rawNews }
      ]
    });

    const macro = await getFedRate();
    const oil = await getOilPrice();
    const spy = await getSPY();
    const sentiment = calculateSentiment(filteredArticles);

    const score = calculateTotalScore({ ...macro, oil }, sentiment);
    const signal = scoreToSignal(score);

    const report = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "정량 신호 변경 금지, 해석만 수행"
        },
        {
          role: "user",
          content: `
SPY: ${spy}
금리: ${macro.value}
유가: ${oil.value}
sentiment: ${sentiment}

신호:
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
      report,
      signal,
      spy,
      sentiment,
      score,
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
