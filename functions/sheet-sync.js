/**
 * howru → 생활_허브 시트 동기화 도우미
 *
 * howru에서 저장한 하루 체크인을 시트의 `_howru` 탭에 한 날짜당 한 줄로 기록합니다.
 * 모든 값은 RAW로 쓰기 때문에 메모가 "="로 시작해도 수식으로 실행되지 않습니다.
 * 날짜는 상태_일간의 날짜와 같은 "날짜 값"(시트 일련번호)으로 씁니다.
 */

const LEVEL_NAMES = {
  5: '아주 좋아',
  4: '좋아',
  3: '그럭저럭',
  2: '별로야',
  1: '힘들어',
};

// index.html의 REASON_SHORT와 동일
const REASON_LABELS = {
  work: '일·학업',
  relation: '관계',
  body: '건강·몸',
  money: '돈·재정',
  env: '날씨·환경',
  food: '음식',
  hobby: '취미·여가',
  unknown: '모르겠어',
};

// 시트 날짜 일련번호: 1899-12-30을 0으로 센 일수
function dateKeyToSerial(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round(ms / 86400000) + 25569;
}

// 밀리초 시각 → 'YYYY-MM-DD HH:mm' (한국 시간)
function formatKst(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  return new Date(n + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

// Firestore 항목 → [컨디션, 컨디션 이름, 이유, 메모, 저장시각]
function buildRow(entry) {
  const level = Number(entry.level);
  const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
  return [
    level,
    LEVEL_NAMES[level] || '',
    reasons.map((k) => REASON_LABELS[k] || String(k)).join(', '),
    typeof entry.note === 'string' ? entry.note : '',
    formatKst(entry.ts),
  ];
}

/**
 * `_howru` 탭에서 날짜가 같은 줄을 찾아 고치고, 없으면 맨 아래에 추가합니다.
 * row가 null이면(앱에서 항목을 지운 경우) 그 줄을 비웁니다.
 */
async function upsertRow(sheets, cfg, dateKey, row) {
  const serial = dateKeyToSerial(dateKey);
  if (serial === null) throw new Error(`bad dateKey: ${dateKey}`);

  const tab = `'${cfg.sheetName}'`;
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: `${tab}!A:A`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const col = got.data.values || [];

  let rowNum = -1;
  for (let i = 1; i < col.length; i++) {
    if (col[i] && Number(col[i][0]) === serial) {
      rowNum = i + 1;
      break;
    }
  }

  if (row === null) {
    if (rowNum > 0) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: cfg.spreadsheetId,
        range: `${tab}!A${rowNum}:F${rowNum}`,
      });
    }
    return { action: rowNum > 0 ? 'cleared' : 'noop', rowNum };
  }

  const values = [[serial, ...row]];
  if (rowNum > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheetId,
      range: `${tab}!A${rowNum}:F${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    return { action: 'updated', rowNum };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { action: 'appended', rowNum: -1 };
}

module.exports = { LEVEL_NAMES, REASON_LABELS, dateKeyToSerial, formatKst, buildRow, upsertRow };
