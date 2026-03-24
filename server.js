import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;

const DB_FILE = "./backtest.json";

// ================= DB =================
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch {
    return [];
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

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

// ================= GPT =================
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

    if (!res) return null;

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;

  } catch {
    return null;
  }
}

// ================= SPY =================
async function getSPYChange() {
  try {
    let change1d = 0;

    const url = `https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB_KEY}`;
    const res = await fetchWithTimeout(url);
    const data = res ? await res.json() : null;

    if (data?.c && data?.pc) {
      change1d = ((data.c - data.pc) / data.pc) * 100;
    }

    return { change1d };

  } catch {
    return { change1d: 0 };
  }
}

// ================= 뉴스 =================
async function getNews() {
  const query = `("S&P 500" OR "Federal Reserve" OR inflation OR CPI)`;

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;

  const res = await fetchWithTimeout(url);
  const data = res ? await res.json() : null;

  return (data?.articles || []).map(a => a.title).slice(0, 5);
}

// ================= sentiment =================
async function getSentiment(articles) {
  let total = 0;

  for (const text of articles) {
    const result = await fetchGPT([
      { role: "system", content: "Return number between -2 and 2 only" },
      { role: "user", content: text }
    ]);

    const match = result?.match(/-?\d+/);
    if (match) total += parseFloat(match[0]);
  }

  return articles.length ? total / articles.length : 0;
}

// ================= signal =================
function getSignal(score) {
  if (score > 0.5) return "Bullish";
  if (score < -0.5) return "Bearish";
  return "Neutral";
}

// ================= generate =================
async function generateSignal() {
  const news = await getNews();
  const sentiment = await getSentiment(news);
  const spy = await getSPYChange();

  const score = sentiment + spy.change1d * 0.2;
  const signal = getSignal(score);

  return { signal, score, spy };
}

// ================= 저장 =================
app.get("/save", async (req, res) => {
  const db = loadDB();

  const result = await generateSignal();

  db.push({
    date: new Date().toISOString(),
    signal: result.signal,
    score: result.score,
    spy: result.spy.change1d
  });

  saveDB(db);

  res.json(result);
});

// ================= 분석 =================
app.get("/analyze", (req, res) => {
  const db = loadDB();

  let win = 0;
  let total = 0;
  let profit = 0;

  for (let i = 0; i < db.length - 1; i++) {
    const today = db[i];
    const next = db[i + 1];

    if (today.signal === "Bullish" && next.spy > 0) {
      win++;
      profit += next.spy;
    } else if (today.signal === "Bearish" && next.spy < 0) {
      win++;
      profit += Math.abs(next.spy);
    }

    total++;
  }

  res.json({
    total,
    winRate: total ? (win / total) * 100 : 0,
    profit
  });
});

app.listen(PORT, () => {
  console.log("🚀 R3 Backtest Server running");
});
