import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let reports = {};

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

// fetch timeout
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

// 🔥 GPT 요청 안정화 (핵심)
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
        },
        30000
      );

      const data = await res?.json();

      console.log("🧠 GPT RAW:", JSON.stringify(data, null, 2));

      if (data?.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
      }

      console.log(`⚠️ GPT 응답 이상 → 재시도 (${i + 1})`);

    } catch (err) {
      console.log(`❌ GPT 요청 실패 (${i + 1}):`, err.message);
    }
  }

  return null;
}

// 매크로 데이터
async function getMacroData() {
  return {
    oil: 75 + Math.random() * 10,
    rate: 5.25
  };
}

// 키워드
const keywords = [
  "inflation","interest rate","fed","oil","recession",
  "economy","earnings","AI","semiconductor","geopolitics"
];

// 후처리
function refineReport(text) {
  if (!text) return text;

  return text
    .replace(/Bear\s*\+\s*(\d+)%/gi, "Bearish ($1%)")
    .replace(/Bull\s*\+\s*(\d+)%/gi, "Bullish ($1%)")
    .replace(/Neutral\s*\+\s*(\d+)%/gi, "Neutral ($1%)")
    .replace(/매도 포지션 구축/gi, "비중 축소 고려")
    .replace(/강한 매도/gi, "보수적 접근 필요")
    .replace(/적극 매수/gi, "비중 확대 고려");
}

// 리포트 생성
async function generateReport(trigger = "manual") {
  let reportText = "";

  try {
    // STEP1: 뉴스 필터링
    const trustedSources = [
      "Reuters","Bloomberg","CNBC","Financial Times",
      "BBC News","The Wall Street Journal","Associated Press"
    ];

    const newsUrl = `https://newsapi.org/v2/everything?q=(stock OR inflation OR interest rate OR oil OR fed OR economy)&language=en&sortBy=publishedAt&pageSize=30&apiKey=${NEWS_API_KEY}`;

    const newsRes = await fetchWithTimeout(newsUrl);
    const newsData = await newsRes?.json();

    let articles = newsData?.articles || [];

    let filteredArticles = articles.filter(a =>
      trustedSources.includes(a.source.name)
    );

    if (filteredArticles.length < 5) {
      filteredArticles = articles.slice(0, 15);
    }

    // STEP2: 키워드 힌트
    const keywordCount = {};
    keywords.forEach(k => keywordCount[k] = 0);

    filteredArticles.forEach(article => {
      const text = (article.title + " " + article.description).toLowerCase();
      keywords.forEach(keyword => {
        if (text.includes(keyword)) keywordCount[keyword]++;
      });
    });

    const topKeywordHints = Object.entries(keywordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // STEP2.5: 클러스터링
    const rawNews = filteredArticles.slice(0, 10).map(a => a.title).join("\n");

    const structuredIssues = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
너는 금융 리서치 애널리스트다.

- 반복된 이슈 우선
- 매크로 중심
- 과적합 금지
`
        },
        {
          role: "user",
          content: `
뉴스:
${rawNews}

힌트:
${JSON.stringify(topKeywordHints)}
`
        }
      ]
    });

    // STEP3: 매크로
    const macro = await getMacroData();

    // STEP4: 최종 분석
    reportText = await fetchGPT({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
기관 투자자 수준 분석.

- 방향성 + 확률
- 단기/중기
- 균형 유지
`
        },
        {
          role: "user",
          content: `
이슈:
${structuredIssues}

유가: ${macro.oil}
금리: ${macro.rate}

분석 작성
`
        }
      ]
    });

    // 🔥 fallback
    if (!reportText) {
      reportText = `
⚠️ 분석 실패 (자동 fallback)

현재 API 응답이 불안정합니다.
잠시 후 다시 시도해주세요.
`;
    }

    reportText = refineReport(reportText);

    const id = new Date().toISOString();

    reports[id] = {
      id,
      createdAt: new Date(),
      report: reportText,
      views: 0,
      trigger
    };

    return reports[id];

  } catch (err) {
    console.log("❌ 전체 실패:", err.message);

    return {
      report: "⚠️ 시스템 오류"
    };
  }
}

// API
app.get("/news/generate", async (req, res) => {
  res.json(await generateReport("manual"));
});

app.get("/news/latest", (req, res) => {
  const keys = Object.keys(reports);
  res.json(reports[keys[keys.length - 1]]);
});

// cron
cron.schedule("0 6 * * *", () => generateReport("morning"));
cron.schedule("0 21 * * *", () => generateReport("evening"));

app.listen(PORT, () => {
  console.log("🚀 Server running");
});
