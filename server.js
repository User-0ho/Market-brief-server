import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import yahooFinance from "yahoo-finance2";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

// ==================== fetch ====================
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ==================== JSON ====================
async function safeJsonParse(res) {
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ==================== GPT ====================
async function fetchGPT(messages) {
  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages
        })
      }
    );

    const data = res ? await safeJsonParse(res) : null;
    return data?.choices?.[0]?.message?.content || null;

  } catch {
    return null;
  }
}

// ==================== FRED ====================
async function getFedRate() {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=5`;

    const res = await fetchWithTimeout(url);
    const data = res ? await safeJsonParse(res) : null;

    if (!data?.observations || data.observations.length < 2) {
      return { value: 5.25, change: 0 };
    }

    const latest = parseFloat(data.observations[0].value);
    const prev = parseFloat(data.observations[1].value);

    return {
      value: latest,
      change: latest - prev
    };

  } catch {
    return { value: 5.25, change: 0 };
  }
}

// ==================== OIL (Alpha Vantage 정상화) ====================
async function getOilPrice() {
  try {
    const url = `https://www.alphavantage.co/query?function=WTI&apikey=${ALPHA_VANTAGE_KEY}`;

    const res = await fetchWithTimeout(url);
    const data = res ? await safeJsonParse(res) : null;

    if (!data?.data || data.data.length < 2) {
      console.log("⚠️ Alpha Vantage fallback");
      return { value: 75, change: 0 };
    }

    const latest = parseFloat(data.data[0].value);
    const prev = parseFloat(data.data[1].value);

    return {
      value: latest,
      change: ((latest - prev) / prev) * 100
    };

  } catch (err) {
    console.log("❌ Oil error:", err.message);
    return { value: 75, change: 0 };
  }
}

// ==================== SPY (R2 완성) ====================
async function getSPYChange() {
  try {
    // ===== Stooq (기반) =====
    const stooqUrl = "https://stooq.com/q/d/l/?s=spy.us&i=d";
    const res = await fetchWithTimeout(stooqUrl);

    if (!res) throw new Error("stooq fail");

    const text = await res.text();

    const lines = text.split("\n").slice(1).filter(l => l.trim());

    const prices = lines
      .map(line => {
        const parts = line.split(",");
        const close = parseFloat(parts[4]);
        return isNaN(close) ? null : close;
      })
      .filter(v => v !== null);

    if (prices.length < 25) throw new Error("not enough data");

    const prev1 = prices[prices.length - 2];
    const prev5 = prices[prices.length - 6];
    const prev20 = prices[prices.length - 21];

    let currentPrice = prices[prices.length - 1];

    // ===== yahoo-finance2 (핵심) =====
    try {
      const quote = await yahooFinance.quote("SPY");
      if (quote?.regularMarketPrice) {
        currentPrice = quote.regularMarketPrice;
      }
    } catch {
      console.log("⚠️ yahoo fallback");
    }

    return {
      change1d: ((currentPrice - prev1) / prev1) * 100,
      change5d: ((currentPrice - prev5) / prev5) * 100,
      change20d: ((currentPrice - prev20) / prev20) * 100
    };

  } catch (err) {
    console.log("❌ SPY error:", err.message);
    return { change1d: 0, change5d: 0, change20d: 0 };
  }
}

// ==================== 뉴스 (핵심 개선 🔥) ====================
async function getNews() {
  const query = `
("S&P 500" OR "Federal Reserve" OR inflation OR CPI OR "interest rate" OR recession OR economy)
AND (market OR stocks)
`;

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWS_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = res ? await safeJsonParse(res) : null;

  const trusted = ["Reuters", "Bloomberg", "CNBC", "Financial Times"];

  return (data?.articles || [])
    .filter(a => trusted.includes(a.source.name))
    .slice(0, 10);
}

// ==================== sentiment ====================
async function getSentiment(text) {
  const result = await fetchGPT([
    { role: "system", content: "뉴스 감정을 -2~2 숫자로만 반환" },
    { role: "user", content: text }
  ]);

  const num = parseFloat(result);
  return isNaN(num) ? 0 : num;
}

// ==================== SCORE ====================
function calculateScore(macro, oil, spy, sentiment) {
  let score = 0;

  if (macro.change > 0.1) score -= 2;
  if (oil.change > 2) score -= 1;

  if (spy.change1d > 1) score += 1;
  if (spy.change1d < -1) score -= 1;

  if (spy.change5d > 2) score += 2;
  if (spy.change5d < -2) score -= 2;

  if (spy.change20d > 5) score += 2;
  if (spy.change20d < -5) score -= 2;

  score += sentiment;

  return score;
}

// ==================== SIGNAL ====================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function scoreToSignal(score) {
  const prob = Math.round(sigmoid(score) * 100);

  if (score > 1) return { direction: "Bullish", prob };
  if (score < -1) return { direction: "Bearish", prob };
  return { direction: "Neutral", prob };
}

// ==================== MAIN ====================
async function generateReport() {
  try {
    const articles = await getNews();
    const newsText = articles.map(a => a.title).join("\n");

    const sentiment = await getSentiment(newsText);

    const macro = await getFedRate();
    const oil = await getOilPrice();
    const spy = await getSPYChange();

    const score = calculateScore(macro, oil, spy, sentiment);
    const signal = scoreToSignal(score);

    const report = await fetchGPT([
      {
        role: "system",
        content: "정량 데이터 기반 투자 분석 작성"
      },
      {
        role: "user",
        content: `
SPY: ${JSON.stringify(spy)}
금리 변화: ${macro.change}
유가 변화: ${oil.change}
sentiment: ${sentiment}

결론:
${signal.direction} (${signal.prob}%)
`
      }
    ]);

    return {
      report,
      signal,
      spy,
      oil,
      macro,
      sentiment,
      score
    };

  } catch {
    return { report: "오류" };
  }
}

// ==================== API ====================
app.get("/news/generate", async (req, res) => {
  res.json(await generateReport());
});

app.listen(PORT, () => {
  console.log("🚀 R2 Server running");
});
