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

// 매크로 데이터
async function getMacroData() {
  return {
    oil: 75 + Math.random() * 10,
    rate: 5.25
  };
}

// 키워드 힌트
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

    // STEP2.5: 의미 클러스터링 (🔥 과적합 방지 버전)
    const rawNews = filteredArticles.slice(0, 10).map(a => a.title).join("\n");

    let structuredIssues = "";

    try {
      const clusterRes = await fetchWithTimeout(
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
너는 기관 금융 리서치 애널리스트다.

규칙:
- 반복적으로 등장한 이슈를 우선적으로 선택
- 거시경제(금리, 유가, 인플레이션 등)를 가장 중요하게 고려
- 단일 뉴스는 가능한 배제하되, 시장 의미가 있다면 보조적으로 허용
- 과도한 제거 금지 (균형 유지)

출력:
핵심 이슈 3개 (중요도 순)
각 이슈는:
- 상태
- 원인
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
          })
        }
      );

      const clusterData = await clusterRes?.json();
      structuredIssues = clusterData?.choices?.[0]?.message?.content;

    } catch (err) {
      console.log("❌ 클러스터링 실패:", err.message);
    }

    // STEP3: 매크로 데이터
    const macro = await getMacroData();

    // STEP4: 최종 분석
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
너는 기관 투자자 수준 애널리스트다.

규칙:
- 핵심 매크로 중심 분석
- 방향성 + 확률 (%)
- 단기 / 중기 구분
- 단정적 표현 금지
- 균형 잡힌 해석 (과도한 확신 금지)
`
              },
              {
                role: "user",
                content: `
핵심 이슈:
${structuredIssues}

매크로:
- 유가: ${macro.oil}
- 금리: ${macro.rate}

형식:

### 1. 핵심 매크로 요약

### 2. 시장 방향성
(Bullish / Neutral / Bearish + 확률 %)

### 3. 시간별 전망
- 단기 (1~2주)
- 중기 (1~3개월)

### 4. 리스크 시나리오

### 5. 반전 시나리오

### 6. 섹터 영향

### 7. 투자 전략
`
              }
            ]
          })
        }
      );

      const gptData = await gptRes?.json();
      reportText = gptData?.choices?.[0]?.message?.content;

      reportText = refineReport(reportText);

    } catch (err) {
      console.log("❌ GPT 실패:", err.message);
    }

    if (!reportText) {
      reportText = "⚠️ 분석 실패";
    }

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
