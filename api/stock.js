// Vercel 서버리스 프록시: 한국(KIS)·미국(FMP) 주식 데이터 통합
// 브라우저 CORS 우회 + API 키를 서버에 숨김 + KIS 토큰 캐싱
//
// 환경변수(Vercel 대시보드 Settings > Environment Variables에 등록):
//   FMP_KEY        = Financial Modeling Prep 무료 API 키
//   KIS_APPKEY     = 한국투자증권 App Key (36자리)
//   KIS_APPSECRET  = 한국투자증권 App Secret (180자리)
//
// 호출 방법(앱에서):
//   /api/stock?market=US&ticker=NVDA
//   /api/stock?market=KR&code=005930
//
// 응답(공통 포맷, 못 구한 값은 null):
//   { price, per, pbr, psr, roe, opMargin, debtRatio, revGrowth, opGrowth,
//     lo52, hi52, beta, target, mcap, ret3m, name }

// ---- KIS 접근토큰 메모리 캐시 (서버 인스턴스가 warm한 동안 재사용) ----
let kisToken = null;
let kisTokenExp = 0;

async function getKisToken() {
  const now = Date.now();
  if (kisToken && now < kisTokenExp - 60000) return kisToken; // 만료 1분 전까지 재사용
  const res = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패: ' + JSON.stringify(data));
  kisToken = data.access_token;
  // expires_in(초) 또는 24시간 기본
  kisTokenExp = now + (data.expires_in ? data.expires_in * 1000 : 86400000);
  return kisToken;
}

// ---- 지연 헬퍼 ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- KIS 공통 GET 헬퍼 (rate limit 대응: 실패 시 지연 후 1회 재시도) ----
async function kisGet(path, params, trId, retry = true) {
  const token = await getKisToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch('https://openapi.koreainvestment.com:9443' + path + '?' + qs, {
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer ' + token,
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
      tr_id: trId,
      custtype: 'P',
    },
  });
  const data = await res.json();
  // rate limit(초당 제한)이나 빈 output이면 잠시 쉬고 1회 재시도
  const hasData = (data.output && (!Array.isArray(data.output) || data.output.length)) ||
                  (data.output1) ||
                  (data.output2 && Array.isArray(data.output2) && data.output2.length);
  const rateLimited = data.msg_cd === 'EGW00201' || data.rt_cd === '1';
  if ((!hasData || rateLimited) && retry) {
    await sleep(350);
    return kisGet(path, params, trId, false);
  }
  return data;
}

// ---- 한국주식: 시세 + 재무비율 통합 ----
async function fetchKR(code) {
  const num = (v) => (v === undefined || v === '' || v === null ? null : parseFloat(v));

  // 1) 현재가 시세: 현재가·PER·PBR·EPS·BPS·52주·시총
  const price = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
    'FHKST01010100'
  );
  const o = price.output || {};

  // 헬퍼: output 배열에서 stac_yymm이 12월로 끝나는 최근 연간 행 선택
  const pickAnnual = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return {};
    return arr.find(r => String(r.stac_yymm || '').endsWith('12')) || arr[0];
  };

  // 2) 재무비율: ROE·부채비율·EPS·BPS — 0(년), 12월 연간 행 선택
  let fr = {};
  try {
    const r = await kisGet(
      '/uapi/domestic-stock/v1/finance/financial-ratio',
      { fid_input_iscd: code, fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J' },
      'FHKST66430300'
    );
    fr = pickAnnual(r.output);
  } catch (e) {}

  // 3) 성장성비율: 매출성장·영익성장 — 0(년), 12월 연간 행 선택
  let gr = {};
  try {
    await sleep(150);
    const g = await kisGet(
      '/uapi/domestic-stock/v1/finance/growth-ratio',
      { fid_input_iscd: code, fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J' },
      'FHKST66430800'
    );
    gr = pickAnnual(g.output);
  } catch (e) {}

  // 4) 손익계산서: 0(년), 12월 연간 행 선택 → 영업이익률·PSR 계산
  let incRows = [];
  try {
    await sleep(150); // 직전 호출과 간격
    let ic = await kisGet(
      '/uapi/domestic-stock/v1/finance/income-statement',
      { fid_input_iscd: code, fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J' },
      'FHKST66430200'
    );
    incRows = Array.isArray(ic.output) ? ic.output : [];
    if (!incRows.length) { // 그래도 비면 한 번 더
      await sleep(400);
      ic = await kisGet(
        '/uapi/domestic-stock/v1/finance/income-statement',
        { fid_input_iscd: code, fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J' },
        'FHKST66430200', false
      );
      incRows = Array.isArray(ic.output) ? ic.output : [];
    }
  } catch (e) {}
  const annual = pickAnnual(incRows);
  const sale = num(annual.sale_account);
  const op = num(annual.bsop_prti);
  const mcapUnit = num(o.hts_avls);

  let opMargin = null, psr = null;
  if (op != null && sale) opMargin = op / sale * 100;
  if (mcapUnit != null && sale) psr = mcapUnit / sale;

  // 5) 종목투자의견: 최근 ~6개월 증권사 목표가 평균 (컨센서스)
  let target = null;
  try {
    await sleep(150);
    const today = new Date();
    const d2 = today.toISOString().slice(0, 10).replace(/-/g, '');
    const past = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 180);
    const d1 = past.toISOString().slice(0, 10).replace(/-/g, '');
    const op2 = await kisGet(
      '/uapi/domestic-stock/v1/quotations/invest-opinion',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16633',
        FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2 },
      'FHKST663300C0'
    );
    const rows = Array.isArray(op2.output) ? op2.output : [];
    const goals = rows.map(r => num(r.hts_goal_prc)).filter(v => v && v > 0);
    if (goals.length) target = Math.round(goals.reduce((a, b) => a + b, 0) / goals.length);
  } catch (e) {}

  // 6) 3개월 수익률: 기간별시세(일봉)에서 ~3개월 전 종가 대비 현재가
  let ret3m = null;
  try {
    await sleep(150);
    const today = new Date();
    const d2 = today.toISOString().slice(0, 10).replace(/-/g, '');
    const past = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 95); // 약 3개월 + 여유
    const d1 = past.toISOString().slice(0, 10).replace(/-/g, '');
    const chart = await kisGet(
      '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2,
        FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0' },
      'FHKST03010100'
    );
    const series = Array.isArray(chart.output2) ? chart.output2 : [];
    const closes = series.map(r => num(r.stck_clpr)).filter(v => v && v > 0);
    const nowPx = num(o.stck_prpr);
    if (closes.length && nowPx) {
      const oldPx = closes[closes.length - 1]; // 가장 오래된(=약 3개월 전) 종가
      ret3m = (nowPx / oldPx - 1) * 100;
    }
  } catch (e) {}

  // 7) 수급: 최근 일별 외국인+기관 순매수 누적 (순매수 ÷ 누적거래량으로 정규화)
  //    당일분은 장 마감(15:40) 후에만 조회되므로, 시작일을 며칠 전으로 두어 직전 거래일까지 확보
  let flowScore = null, frgnNtby = null, orgnNtby = null;
  const fetchFlow = async (daysAgo) => {
    const dt = new Date(Date.now() - 1000 * 60 * 60 * 24 * daysAgo);
    const d1 = dt.toISOString().slice(0, 10).replace(/-/g, '');
    return kisGet(
      '/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: d1, FID_ORG_ADJ_PRC: '', FID_ETC_CLS_CODE: '1' },
      'FHPTJ04160001'
    );
  };
  try {
    await sleep(150);
    let flow = await fetchFlow(2);            // 2일 전부터 (주말·장중 대비)
    let rows = Array.isArray(flow.output2) ? flow.output2 : [];
    if (!rows.length) {                        // 비면 더 과거(연휴 등)
      await sleep(300);
      flow = await fetchFlow(7);
      rows = Array.isArray(flow.output2) ? flow.output2 : [];
    }
    if (rows.length) {
      let f = 0, g = 0, vol = 0;
      for (const r of rows) {
        f += num(r.frgn_ntby_qty) || 0;
        g += num(r.orgn_ntby_qty) || 0;
        vol += num(r.acml_vol) || 0;
      }
      frgnNtby = f; orgnNtby = g;
      if (vol > 0) flowScore = (f + g) / vol * 100;
    }
  } catch (e) {}

  return {
    price: num(o.stck_prpr),
    per: num(o.per),
    pbr: num(o.pbr),
    psr: psr,
    roe: num(fr.roe_val),
    opMargin: opMargin,
    debtRatio: num(fr.lblt_rate),
    revGrowth: num(gr.grs),
    opGrowth: num(gr.bsop_prfi_inrt),
    lo52: num(o.w52_lwpr),
    hi52: num(o.w52_hgpr),
    beta: null,
    target: target,
    mcap: mcapUnit,
    eps: num(o.eps),
    bps: num(o.bps),
    ret3m: ret3m,
    flow: flowScore,
    frgnNtby: frgnNtby,
    orgnNtby: orgnNtby,
    name: o.hts_kor_isnm || code,
    _raw_market: 'KR',
    _period: { fr: fr.stac_yymm, gr: gr.stac_yymm, inc: annual.stac_yymm },
  };
}

// ---- 미국주식: FMP 신규 /stable/ 경로 (2025.9 이후) ----
async function fetchUS(ticker, debug) {
  const key = process.env.FMP_KEY;
  const base = 'https://financialmodelingprep.com/stable';
  const num = (v) => (v === undefined || v === '' || v === null ? null : parseFloat(v));
  const _dbg = {};

  // 1) quote: 현재가·시총·PER·EPS·52주
  let Q = {};
  try {
    const resp = await fetch(`${base}/quote?symbol=${ticker}&apikey=${key}`);
    const txt = await resp.text();
    if (debug) _dbg.quoteRaw = txt.slice(0, 300);
    let q; try { q = JSON.parse(txt); } catch { q = null; }
    Q = Array.isArray(q) && q[0] ? q[0] : (q && q.symbol ? q : {});
  } catch (e) { if (debug) _dbg.quoteErr = String(e); }

  // 2) ratios-ttm: PBR·PSR·ROE·영업이익률·부채비율
  let R = {};
  try {
    const resp = await fetch(`${base}/ratios-ttm?symbol=${ticker}&apikey=${key}`);
    const txt = await resp.text();
    if (debug) _dbg.ratiosRaw = txt.slice(0, 300);
    let r; try { r = JSON.parse(txt); } catch { r = null; }
    R = Array.isArray(r) && r[0] ? r[0] : (r && !r['Error Message'] ? r : {});
  } catch (e) { if (debug) _dbg.ratiosErr = String(e); }

  // 3) 애널리스트 목표가 컨센서스
  let target = null;
  try {
    const t = await (await fetch(`${base}/price-target-consensus?symbol=${ticker}&apikey=${key}`)).json();
    const T = Array.isArray(t) && t[0] ? t[0] : {};
    target = num(T.targetConsensus) || num(T.targetMedian) || num(T.targetHigh);
  } catch (e) {}

  // 4) profile: 베타
  let beta = null;
  try {
    const p = await (await fetch(`${base}/profile?symbol=${ticker}&apikey=${key}`)).json();
    const P = Array.isArray(p) && p[0] ? p[0] : (p && p.symbol ? p : {});
    beta = num(P.beta);
  } catch (e) {}

  // 5) stock-price-change: 3개월 수익률(%)
  let ret3m = null;
  try {
    const c = await (await fetch(`${base}/stock-price-change?symbol=${ticker}&apikey=${key}`)).json();
    const C = Array.isArray(c) && c[0] ? c[0] : (c && c.symbol ? c : {});
    ret3m = num(C['3M']);
  } catch (e) {}

  // 6) income-statement-growth: 최근 연도 매출·영익 성장률 (소수→%)
  let revGrowth = null, opGrowth = null;
  try {
    const g = await (await fetch(`${base}/income-statement-growth?symbol=${ticker}&limit=1&apikey=${key}`)).json();
    const G = Array.isArray(g) && g[0] ? g[0] : {};
    if (G.growthRevenue != null) revGrowth = num(G.growthRevenue) * 100;
    if (G.growthOperatingIncome != null) opGrowth = num(G.growthOperatingIncome) * 100;
  } catch (e) {}

  return {
    price: num(Q.price),
    per: num(R.priceToEarningsRatioTTM) || num(Q.pe) || num(Q.priceEarningsRatio),
    pbr: num(R.priceToBookRatioTTM),
    psr: num(R.priceToSalesRatioTTM),
    // ROE는 이 엔드포인트에 직접 없음 → 주당순이익÷주당자본 ×100 으로 계산
    roe: (R.netIncomePerShareTTM != null && R.shareholdersEquityPerShareTTM)
         ? num(R.netIncomePerShareTTM) / num(R.shareholdersEquityPerShareTTM) * 100 : null,
    opMargin: R.operatingProfitMarginTTM != null ? num(R.operatingProfitMarginTTM) * 100 : null,
    debtRatio: R.debtToEquityRatioTTM != null ? num(R.debtToEquityRatioTTM) * 100 : null,
    revGrowth: revGrowth,
    opGrowth: opGrowth,
    lo52: num(Q.yearLow),
    hi52: num(Q.yearHigh),
    beta: beta,
    target: target,
    mcap: num(Q.marketCap),
    eps: num(R.netIncomePerShareTTM),
    bps: num(R.bookValuePerShareTTM),
    ret3m: ret3m,
    name: Q.name || ticker,
    _raw_market: 'US',
    ...(debug ? { _dbg } : {}),
  };
}

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { market, ticker, symbol, code } = req.query;
  try {
    let out;
    if (market === 'KR') {
      if (!code) return res.status(400).json({ error: 'code(6자리 종목코드) 필요' });
      out = await fetchKR(code);
    } else if (market === 'US') {
      const sym = ticker || symbol;
      if (!sym) return res.status(400).json({ error: 'ticker 또는 symbol 필요' });
      out = await fetchUS(sym, req.query.debug === '1');
    } else {
      return res.status(400).json({ error: 'market=US 또는 KR 필요' });
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
