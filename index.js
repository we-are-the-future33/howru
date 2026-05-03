/**
 * howru — Cloud Functions
 *
 * 매시간 정각에 실행되어 fcmTokens 컬렉션에서
 * 현재 UTC 시각과 일치하는 토큰들을 찾아 푸시 발송합니다.
 *
 * Trigger: Cloud Scheduler (매시간 정각)
 * Region: asia-northeast3 (Seoul)
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('firebase-functions/logger');

initializeApp();

// 모든 함수의 기본 region을 서울로 설정
setGlobalOptions({ region: 'asia-northeast3' });

const db = getFirestore();
const messaging = getMessaging();

// ===== 푸시 메시지 설정 =====
const NOTIFICATION_TITLE = 'howru';
const NOTIFICATION_BODY = '오늘 기분 어땠어요?';
const NOTIFICATION_ICON = '/icon-192.png';
const APP_URL = 'https://howru-one.vercel.app';

/**
 * 매시간 정각에 실행 (cron: '0 * * * *')
 * - 현재 UTC 시각의 hour(0~23)를 가져옴
 * - collectionGroup으로 모든 user의 fcmTokens 중 notifHourUtc == 현재시각인 것들 조회
 * - uid별로 그룹핑 후 모든 디바이스에 발송
 * - 만료/무효 토큰은 Firestore에서 삭제
 */
exports.sendDailyPush = onSchedule(
  {
    schedule: '0 * * * *',  // 매시간 정각 (UTC 기준)
    timeZone: 'UTC',
    region: 'asia-northeast3',
  },
  async (event) => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    logger.info(`[push] sendDailyPush triggered at UTC ${utcHour}:00`);

    // 1) 이 시각에 알림 받기로 한 모든 토큰 조회
    let snapshot;
    try {
      snapshot = await db
        .collectionGroup('fcmTokens')
        .where('notifHourUtc', '==', utcHour)
        .get();
    } catch (e) {
      logger.error('[push] failed to query fcmTokens:', e);
      throw e;
    }

    if (snapshot.empty) {
      logger.info(`[push] no tokens for UTC ${utcHour}:00`);
      return null;
    }

    logger.info(`[push] ${snapshot.size} token(s) found for UTC ${utcHour}:00`);

    // 2) 토큰 + Firestore 문서 ref 수집
    const targets = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!data.token) return;
      targets.push({
        token: data.token,
        ref: doc.ref,
        uid: doc.ref.parent.parent.id,  // users/{uid}/fcmTokens/{token}
      });
    });

    // 3) FCM 메시지 빌드
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
          tag: 'howru-daily',  // 같은 tag면 새 알림이 이전 것을 덮어씀
        },
        fcmOptions: {
          link: APP_URL,  // 알림 클릭 시 열릴 URL
        },
      },
    }));

    // 4) 일괄 발송 (FCM은 한 번에 최대 500개까지 가능)
    let response;
    try {
      response = await messaging.sendEach(messages);
    } catch (e) {
      logger.error('[push] sendEach failed:', e);
      throw e;
    }

    logger.info(
      `[push] sent: success=${response.successCount}, failure=${response.failureCount}`
    );

    // 5) 실패한 토큰 분석 → 만료/무효 토큰 자동 삭제
    const tokensToDelete = [];
    response.responses.forEach((res, idx) => {
      if (res.success) return;
      const err = res.error;
      const code = err?.code || '';
      const target = targets[idx];

      logger.warn(
        `[push] failed for uid=${target.uid} token=${target.token.slice(0, 20)}... code=${code}`
      );

      // 토큰이 만료됐거나 등록 해제된 경우 → Firestore에서 삭제
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
      try {
        await batch.commit();
      } catch (e) {
        logger.error('[push] failed to delete stale tokens:', e);
      }
    }

    return {
      utcHour,
      sent: response.successCount,
      failed: response.failureCount,
      cleaned: tokensToDelete.length,
    };
  }
);

/**
 * 수동 테스트용 - HTTP 호출로 즉시 푸시 발송
 * URL: https://asia-northeast3-howru-app.cloudfunctions.net/testPush?hour=14
 *
 * 보안을 위해 비밀 토큰을 쿼리 파라미터로 받음
 * (사용 전 TEST_SECRET을 변경하세요)
 */
const { onRequest } = require('firebase-functions/v2/https');

const TEST_SECRET = 'howru-test-2026';  // 본인만 아는 비밀 문자열로 변경 가능

exports.testPush = onRequest(
  { region: 'asia-northeast3', cors: false },
  async (req, res) => {
    // 인증 체크
    if (req.query.secret !== TEST_SECRET) {
      res.status(403).send('Forbidden');
      return;
    }

    const utcHour = parseInt(req.query.hour, 10);
    if (isNaN(utcHour) || utcHour < 0 || utcHour > 23) {
      // hour가 안 주어졌으면 현재 UTC 시간 사용
      const now = new Date();
      const fallbackHour = now.getUTCHours();
      logger.info(`[testPush] no hour given, using current UTC hour: ${fallbackHour}`);
      return await runPushForHour(fallbackHour, res);
    }

    return await runPushForHour(utcHour, res);
  }
);

async function runPushForHour(utcHour, res) {
  logger.info(`[testPush] running for UTC ${utcHour}:00`);

  const snapshot = await db
    .collectionGroup('fcmTokens')
    .where('notifHourUtc', '==', utcHour)
    .get();

  if (snapshot.empty) {
    res.status(200).json({ utcHour, sent: 0, message: 'no tokens for this hour' });
    return;
  }

  const targets = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    if (!data.token) return;
    targets.push({ token: data.token, ref: doc.ref, uid: doc.ref.parent.parent.id });
  });

  const messages = targets.map((t) => ({
    token: t.token,
    notification: { title: NOTIFICATION_TITLE, body: NOTIFICATION_BODY },
    webpush: {
      notification: { icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON, tag: 'howru-daily' },
      fcmOptions: { link: APP_URL },
    },
  }));

  const response = await messaging.sendEach(messages);

  const tokensToDelete = [];
  response.responses.forEach((r, idx) => {
    if (r.success) return;
    const code = r.error?.code || '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      tokensToDelete.push(targets[idx].ref);
    }
  });

  if (tokensToDelete.length > 0) {
    const batch = db.batch();
    tokensToDelete.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  res.status(200).json({
    utcHour,
    targetCount: targets.length,
    sent: response.successCount,
    failed: response.failureCount,
    cleaned: tokensToDelete.length,
  });
}
