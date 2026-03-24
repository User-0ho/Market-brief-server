import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;

// ================= fetch =================
async function fetchWithTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ================= GPT =================
async function fetchGPT(messages) {
  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions"
    );

    const data = await res.json();

    return data?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

// ================= SPY (🔥 R2.2 핵심) =================
async function getSPYChange() {
  try {
    // ===== 1. Finnhub =====
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB_KEY}`;
      const res = await fetchWithTimeout(url);
      const data = res ? await res.json() : null;

      if (data?.c && data?.pc) {
        const change = ((data.c - data.pc) / data.pc) * 100;

        return {
          change1d: change,
          change5d: change,
          change20d: change
        };
      }
    } catch {
      console.log("⚠️ Finnhub 실패");
    }

    // ===== 2. TwelveData =====
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=SPY&interval=1day&outputsize=20&apikey=${TWELVEDATA_KEY}`;
      const res = await fetchWithTimeout(url);
      const data = res ? await res.json() : null;

      if (data?.values?.length >= 6) {
        const prices = data.values.map(v => parseFloat(v.close));

        const latest = prices[0];
        const prev5 = prices[5];

        const change = ((latest - prev5) / prev5) * 100;

        return {
          change1d: change,
          change5d: change,
          change20d: change
        };
      }
    } catch {
      console.log("⚠️ TwelveData 실패");
    }

    // ===== fallback =====
    return {
      change1d: 0.5,
      change5d: -0.8,
      change20d: 1.5
    };

  } catch {
    return {
      change1d: 0.5,
      change5d: -0.8,
      change20d: 1.5
    };
  }
}

// ================= 금리 =================
async function getFedRate() {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=2`;

    const res = await fetchWithTimeout(url);
    const data = res ? await res.json() : null;

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

// ================= 유가 =================
async function getOilPrice() {
  try {
    const url = `https://api.twelvedata.com/price?symbol=OIL&apikey=${TWELVEDATA_KEY}`;
    const res = await fetchWithTimeout(url);
    const data = res ? await res.json() : null;

    if (data?.price) {
      return {
        value: parseFloat(data.price),
        change: 0
      };
    }

    return { value: 75, change: 0 };

  } catch {
    return { value: 75, change: 0 };
  }
}

// ================= 뉴스 =================
async function getNews() {
  const query = `
("S&P 500" OR "Federal Reserve" OR inflation OR CPI OR "interest rate" OR recession)
AND (market OR stocks)
`;

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = res ? await res.json() : null;

  const trusted = ["Reuters", "Bloomberg", "CNBC"];

  return (data?.articles || [])
    .filter(a => trusted.includes(a.source.name));
}

// ================= sentiment =================
async function getSentiment(text) {
  const result = await fetchGPT([
    { role: "system", content: "Return number between -2 and 2 only" },
    { role: "user", content: text }
  ]);

  const num = parseFloat(result);
  return isNaN(num) ? 0 : num;
}

// ================= score =================
function calculateScore(macro, oil, spy, sentiment) {
  let score = 0;

  if (macro.change > 0.1) score -= 2;
  if (spy.change1d > 1) score += 1;
  if (spy.change1d < -1) score -= 1;

  score += sentiment;

  return score;
}

// ================= signal =================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function scoreToSignal(score) {
  const prob = Math.round(sigmoid(score) * 100);

  if (score > 1) return { direction: "Bullish", prob };
  if (score < -1) return { direction: "Bearish", prob };
  return { direction: "Neutral", prob };
}

// ================= main =================
async function generateReport() {
  const articles = await getNews();
  const newsText = articles.map(a => a.title).join("\n");

  const sentiment = await getSentiment(newsText);
  const macro = await getFedRate();
  const oil = await getOilPrice();
  const spy = await getSPYChange();

  const score = calculateScore(macro, oil, spy, sentiment);
  const signal = scoreToSignal(score);

  return {
    signal,
    spy,
    oil,
    macro,
    sentiment,
    score
  };
}

// ================= API =================
app.get("/news/generate", async (req, res) => {
  res.json(await generateReport());
});

app.listen(PORT, () => {
  console.log("🚀 R2.2 Server running");
});
