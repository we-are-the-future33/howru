/**
 * howru — Cloud Functions
 *
 * 1) sendDailyPush: 매시간 정각에 실행되어 fcmTokens 컬렉션에서
 *    현재 UTC 시각과 일치하는 토큰들을 찾아 푸시 발송합니다.
 * 2) syncEntryToSheet: 체크인을 저장(수정·삭제 포함)하면 생활_허브 시트의
 *    `_howru` 탭에 그 날짜 한 줄을 기록합니다.
 *
 * Last deploy: 2026-10-21 — add syncEntryToSheet (시트 연동)
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth');
const { google } = require('googleapis');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const { buildRow, upsertRow } = require('./sheet-sync');

initializeApp();
setGlobalOptions({ region: 'asia-northeast3' });

const db = getFirestore();
const messaging = getMessaging();

const NOTIFICATION_TITLE = 'howru';
const NOTIFICATION_BODY = '오늘 기분 어땠어요?';
const NOTIFICATION_ICON = '/icon-192.png';
const APP_URL = 'https://howru-one.vercel.app';
const TEST_SECRET = 'howru-test-2026';

// ---- 시트 연동 설정 ----
const SHEET_CONFIG = {
  spreadsheetId: '1H4s89-dY9RLVHYCKcqMzFE2r4zlxgJ8g8r9UhdgaN5Y', // 생활_허브
  sheetName: '_howru',
};
// 허용한 계정의 체크인만 시트로 보냅니다. 이 repo는 공개라서 이메일 대신
// 소문자 이메일의 SHA-256 해시를 둡니다. 계정을 바꾸려면 새 해시로 교체하세요.
const ALLOWED_EMAIL_HASHES = ['6327cec730e86aa188bd41fff2e3ac3b45c619dc35524c4f59bda284461efa83'];
const emailHash = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

exports.syncEntryToSheet = onDocumentWritten(
  { document: 'users/{uid}/entries/{dateKey}', region: 'asia-northeast3' },
  async (event) => {
    const { uid, dateKey } = event.params;

    let email = '';
    try {
      email = ((await getAuth().getUser(uid)).email || '').toLowerCase();
    } catch (e) {
      logger.warn(`[sheet] cannot look up user uid=${uid}: ${e.message}`);
      return;
    }
    if (!email || !ALLOWED_EMAIL_HASHES.includes(emailHash(email))) {
      // Cloud Logging은 프로젝트 소유자만 볼 수 있으므로 여기에는 이메일을 남겨도 됩니다.
      logger.info(`[sheet] skip: ${email || 'no email'} is not allowed`);
      return;
    }

    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const after = event.data && event.data.after;
    const row = after && after.exists ? buildRow(after.data()) : null;

    try {
      const result = await upsertRow(sheets, SHEET_CONFIG, dateKey, row);
      logger.info(`[sheet] ${dateKey} ${result.action}`);
    } catch (e) {
      logger.error(`[sheet] ${dateKey} failed: ${e.message}`);
      throw e;
    }
  }
);

exports.sendDailyPush = onSchedule(
  {
    schedule: '0 * * * *',
    timeZone: 'UTC',
    region: 'asia-northeast3',
  },
  async (event) => {
    const utcHour = new Date().getUTCHours();
    logger.info(`[push] sendDailyPush triggered at UTC ${utcHour}:00`);
    return await runPushForHour(utcHour);
  }
);

exports.testPush = onRequest(
  { region: 'asia-northeast3', cors: false },
  async (req, res) => {
    if (req.query.secret !== TEST_SECRET) {
      res.status(403).send('Forbidden');
      return;
    }
    let utcHour = parseInt(req.query.hour, 10);
    if (isNaN(utcHour) || utcHour < 0 || utcHour > 23) {
      utcHour = new Date().getUTCHours();
    }
    const result = await runPushForHour(utcHour);
    res.status(200).json(result);
  }
);

async function runPushForHour(utcHour) {
  logger.info(`[push] running for UTC ${utcHour}:00`);

  const snapshot = await db
    .collectionGroup('fcmTokens')
    .where('notifHourUtc', '==', utcHour)
    .get();

  if (snapshot.empty) {
    logger.info(`[push] no tokens for UTC ${utcHour}:00`);
    return { utcHour, sent: 0, failed: 0, cleaned: 0 };
  }

  const targets = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (!data.token) return;
    targets.push({
      token: data.token,
      ref: doc.ref,
      uid: doc.ref.parent.parent.id,
    });
  });

  const messages = targets.map((t) => ({
    token: t.token,
    notification: {
      title: NOTIFICATION_TITLE,
      body: NOTIFICATION_BODY,
    },
    webpush: {
      notification: {
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
        tag: 'howru-daily',
      },
      fcmOptions: {
        link: APP_URL,
      },
    },
  }));

  const response = await messaging.sendEach(messages);
  logger.info(`[push] success=${response.successCount}, failure=${response.failureCount}`);

  const tokensToDelete = [];
  response.responses.forEach((res, idx) => {
    if (res.success) return;
    const code = res.error?.code || '';
    const target = targets[idx];
    logger.warn(`[push] failed uid=${target.uid} code=${code}`);
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      tokensToDelete.push(target.ref);
    }
  });

  if (tokensToDelete.length > 0) {
    logger.info(`[push] cleaning up ${tokensToDelete.length} stale token(s)`);
    const batch = db.batch();
    tokensToDelete.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  return {
    utcHour,
    sent: response.successCount,
    failed: response.failureCount,
    cleaned: tokensToDelete.length,
  };
}
