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

// ---- KIS 공통 GET 헬퍼 ----
async function kisGet(path, params, trId) {
  const token = await getKisToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch('https://openapi.koreainvestment.com:9443' + path + '?' + qs, {
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer ' + token,
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
      tr_id: trId,
      custtype: 'P', // 개인
    },
  });
  return res.json();
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

  // 2) 재무비율: ROE·부채비율·EPS·BPS — 0(년) 기준, output[0]=최근 연간
  let fr = {};
  try {
    const r = await kisGet(
      '/uapi/domestic-stock/v1/finance/financial-ratio',
      { fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_input_iscd: code }, // 0=년
      'FHKST66430300'
    );
    fr = (r.output && r.output[0]) ? r.output[0] : {};
  } catch (e) {}

  // 3) 성장성비율: 매출성장·영익성장 — 0(년) 기준
  let gr = {};
  try {
    const g = await kisGet(
      '/uapi/domestic-stock/v1/finance/growth-ratio',
      { fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_input_iscd: code },
      'FHKST66430800'
    );
    gr = (g.output && g.output[0]) ? g.output[0] : {};
  } catch (e) {}

  // 4) 손익계산서: 0(년) 호출 후 stac_yymm이 '12'로 끝나는(연간 전체) 최근 행 선택
  let incRows = [];
  try {
    const ic = await kisGet(
      '/uapi/domestic-stock/v1/finance/income-statement',
      { fid_div_cls_code: '0', fid_cond_mrkt_div_code: 'J', fid_input_iscd: code },
      'FHKST66430200'
    );
    incRows = Array.isArray(ic.output) ? ic.output : [];
  } catch (e) {}
  // 연간 전체(12월 결산) 행만, 가장 최근 것
  const annual = incRows.find(r => String(r.stac_yymm || '').endsWith('12')) || incRows[0] || {};
  const sale = num(annual.sale_account);   // 매출액
  const op = num(annual.bsop_prti);        // 영업이익
  const mcapUnit = num(o.hts_avls);        // 시가총액(억원)

  let opMargin = null, psr = null;
  if (op != null && sale) opMargin = op / sale * 100;          // 영업이익률
  if (mcapUnit != null && sale) psr = mcapUnit / sale;          // PSR = 시총 ÷ 매출 (둘 다 억원)

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
    target: null,
    mcap: mcapUnit,
    eps: num(o.eps),
    bps: num(o.bps),
    ret3m: null,
    name: o.hts_kor_isnm || code,
    _raw_market: 'KR',
    _period: { fr: fr.stac_yymm, gr: gr.stac_yymm, inc: annual.stac_yymm },
  };
}

// ---- 미국주식: FMP 신규 /stable/ 경로 (2025.9 이후) ----
async function fetchUS(ticker) {
  const key = process.env.FMP_KEY;
  const base = 'https://financialmodelingprep.com/stable';
  const num = (v) => (v === undefined || v === '' || v === null ? null : parseFloat(v));

  // 1) quote: 현재가·시총·PER·EPS·52주
  let Q = {};
  try {
    const q = await (await fetch(`${base}/quote?symbol=${ticker}&apikey=${key}`)).json();
    Q = Array.isArray(q) && q[0] ? q[0] : (q && q.symbol ? q : {});
  } catch (e) {}

  // 2) ratios-ttm: PBR·PSR·ROE·영업이익률·부채비율
  let R = {};
  try {
    const r = await (await fetch(`${base}/ratios-ttm?symbol=${ticker}&apikey=${key}`)).json();
    R = Array.isArray(r) && r[0] ? r[0] : (r && !r['Error Message'] ? r : {});
  } catch (e) {}

  // 3) 애널리스트 목표가 컨센서스
  let target = null;
  try {
    const t = await (await fetch(`${base}/price-target-consensus?symbol=${ticker}&apikey=${key}`)).json();
    const T = Array.isArray(t) && t[0] ? t[0] : {};
    target = num(T.targetConsensus) || num(T.targetMedian) || num(T.targetHigh);
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
    revGrowth: null,
    opGrowth: null,
    lo52: num(Q.yearLow),
    hi52: num(Q.yearHigh),
    beta: null,
    target: target,
    mcap: num(Q.marketCap),
    eps: num(R.netIncomePerShareTTM),
    bps: num(R.bookValuePerShareTTM),
    ret3m: null,
    name: Q.name || ticker,
    _raw_market: 'US',
  };
}

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { market, ticker, code } = req.query;
  try {
    let out;
    if (market === 'KR') {
      if (!code) return res.status(400).json({ error: 'code(6자리 종목코드) 필요' });
      out = await fetchKR(code);
    } else if (market === 'US') {
      if (!ticker) return res.status(400).json({ error: 'ticker 필요' });
      out = await fetchUS(ticker);
    } else {
      return res.status(400).json({ error: 'market=US 또는 KR 필요' });
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
