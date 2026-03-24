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
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
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

// ================= GPT (🔥 안정화 핵심) =================
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

    if (!res) {
      console.log("❌ GPT 요청 실패 (no response)");
      return null;
    }

    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.log("❌ GPT JSON 파싱 실패:", text);
      return null;
    }

    if (!data?.choices?.[0]?.message?.content) {
      console.log("❌ GPT 응답 이상:", data);
      return null;
    }

    return data.choices[0].message.content;

  } catch (err) {
    console.log("❌ GPT ERROR:", err.message);
    return null;
  }
}

// ================= SPY =================
async function getSPYChange() {
  try {
    let change1d = 0;
    let change5d = 0;
    let change20d = 0;

    // Finnhub → 1일
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB_KEY}`;
      const res = await fetchWithTimeout(url);
      const data = res ? await res.json() : null;

      if (data?.c && data?.pc) {
        change1d = ((data.c - data.pc) / data.pc) * 100;
      }
    } catch {}

    // TwelveData → 5일 / 20일
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=SPY&interval=1day&outputsize=25&apikey=${TWELVEDATA_KEY}`;
      const res = await fetchWithTimeout(url);
      const data = res ? await res.json() : null;

      if (data?.values?.length >= 21) {
        const prices = data.values.map(v => parseFloat(v.close));

        const latest = prices[0];
        const prev5 = prices[5];
        const prev20 = prices[20];

        change5d = ((latest - prev5) / prev5) * 100;
        change20d = ((latest - prev20) / prev20) * 100;
      }
    } catch {}

    if (change5d === 0) change5d = change1d;
    if (change20d === 0) change20d = change5d;

    return { change1d, change5d, change20d };

  } catch {
    return { change1d: 0.5, change5d: -0.5, change20d: 1.2 };
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

    return { value: latest, change: latest - prev };

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
      return { value: parseFloat(data.price), change: 0 };
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

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWS_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = res ? await res.json() : null;

  const trusted = {
    "Reuters": 1.2,
    "Bloomberg": 1.2,
    "CNBC": 1.0,
    "Financial Times": 1.2
  };

  return (data?.articles || [])
    .filter(a =>
      trusted[a.source.name] &&
      a.description &&
      a.title.length > 20
    )
    .map(a => ({
      text: `${a.title}. ${a.description}`,
      weight: trusted[a.source.name]
    }))
    .slice(0, 15);
}

// ================= sentiment =================
async function getSentiment(articles) {
  try {
    let total = 0;
    let count = 0;

    for (const article of articles) {
      const result = await fetchGPT([
        {
          role: "system",
          content: `
You must return ONLY a number.
-2 to 2 only.
No explanation.
`
        },
        {
          role: "user",
          content: article.text
        }
      ]);

      console.log("GPT RESULT:", result);

      if (!result) continue;

      const match = result.match(/-?\d+(\.\d+)?/);
      const score = match ? parseFloat(match[0]) : NaN;

      if (!isNaN(score)) {
        total += score * article.weight;
        count += article.weight;
      }
    }

    if (count === 0) return 0;

    return total / count;

  } catch {
    return 0;
  }
}

// ================= score =================
function calculateScore(macro, oil, spy, sentiment) {
  let score = 0;

  if (macro.change > 0.1) score -= 2;

  if (spy.change1d > 1) score += 1;
  if (spy.change1d < -1) score -= 1;

  if (spy.change5d > 2) score += 2;
  if (spy.change5d < -2) score -= 2;

  if (spy.change20d > 5) score += 2;
  if (spy.change20d < -5) score -= 2;

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
  const sentiment = await getSentiment(articles);

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
  console.log("🚀 R2.5 FINAL (ULTIMATE) running");
});
