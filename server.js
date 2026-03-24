import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

let reports = {};

// ==================== fetch ====================
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
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
async function fetchGPT(body) {
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

// ==================== OIL (Alpha Vantage) ====================
async function getOilPrice() {
  try {
    const url = `https://www.alphavantage.co/query?function=WTI&apikey=${ALPHA_VANTAGE_KEY}`;

    const res = await fetchWithTimeout(url);
    const data = res ? await safeJsonParse(res) : null;

    if (!data?.data || data.data.length < 2) {
      return { value: 75, change: 0 };
    }

    const latest = parseFloat(data.data[0].value);
    const prev = parseFloat(data.data[1].value);

    return {
      value: latest,
      change: ((latest - prev) / prev) * 100
    };

  } catch {
    return { value: 75, change: 0 };
  }
}

// ==================== SPY 변화율 ====================
let spyHistory = [];

async function getSPYChange() {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=SPY`;
    const res = await fetchWithTimeout(url);

    if (!res) return { change1d: 0, change5d: 0 };

    const text = await res.text();

    if (!text.includes("quoteResponse")) {
      return { change1d: 0, change5d: 0 };
    }

    const data = JSON.parse(text);
    const price = data?.quoteResponse?.result?.[0]?.regularMarketPrice;

    if (!price) return { change1d: 0, change5d: 0 };

    spyHistory.push(price);
    if (spyHistory.length > 10) spyHistory.shift();

    const change1d = spyHistory.length > 1
      ? ((price - spyHistory[spyHistory.length - 2]) / price) * 100
      : 0;

    const change5d = spyHistory.length > 5
      ? ((price - spyHistory[0]) / price) * 100
      : 0;

    return { change1d, change5d };

  } catch {
    return { change1d: 0, change5d: 0 };
  }
}

// ==================== GPT Sentiment ====================
async function getGPTSentiment(text) {
  const result = await fetchGPT({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "뉴스 감정을 -2~+2 숫자로만 평가"
      },
      {
        role: "user",
        content: text
      }
    ]
  });

  const num = parseFloat(result);
  return isNaN(num) ? 0 : num;
}

// ==================== 점수 ====================
function calculateScore(macro, oil, spy, sentiment) {
  let score = 0;

  if (macro.change > 0.1) score -= 2;
  if (oil.change > 2) score -= 1;
  if (spy.change5d > 2) score += 2;
  if (spy.change5d < -2) score -= 2;

  score += sentiment;

  return score;
}

// ==================== 확률 ====================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function scoreToSignal(score) {
  const prob = Math.round(sigmoid(score) * 100);

  if (score > 1) return { direction: "Bullish", prob };
  if (score < -1) return { direction: "Bearish", prob };
  return { direction: "Neutral", prob };
}

// ==================== 리포트 ====================
async function generateReport() {
  try {
    const newsUrl = `https://newsapi.org/v2/everything?q=stock&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = newsRes ? await safeJsonParse(newsRes) : null;

    const articles = newsData?.articles?.slice(0, 5) || [];

    const newsText = articles.map(a => a.title).join("\n");

    const sentiment = await getGPTSentiment(newsText);

    const macro = await getFedRate();
    const oil = await getOilPrice();
    const spy = await getSPYChange();

    const score = calculateScore(macro, oil, spy, sentiment);
    const signal = scoreToSignal(score);

    const report = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "정량 데이터를 기반으로 투자 분석"
        },
        {
          role: "user",
          content: `
SPY 변화율: ${JSON.stringify(spy)}
금리 변화: ${macro.change}
유가 변화: ${oil.change}
sentiment: ${sentiment}

신호:
${signal.direction} (${signal.prob}%)

분석 작성
`
        }
      ]
    });

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
  console.log("🚀 V3 Server running");
});
