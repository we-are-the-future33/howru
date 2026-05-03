/**
 * howru — Cloud Functions
 *
 * 매시간 정각에 실행되어 fcmTokens 컬렉션에서
 * 현재 UTC 시각과 일치하는 토큰들을 찾아 푸시 발송합니다.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('firebase-functions/logger');

initializeApp();
setGlobalOptions({ region: 'asia-northeast3' });

const db = getFirestore();
const messaging = getMessaging();

const NOTIFICATION_TITLE = 'howru';
const NOTIFICATION_BODY = '오늘 기분 어땠어요?';
const NOTIFICATION_ICON = '/icon-192.png';
const APP_URL = 'https://howru-one.vercel.app';
const TEST_SECRET = 'howru-test-2026';

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
