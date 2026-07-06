const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const assign = require('./lib/assign');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

setGlobalOptions({ region: 'asia-northeast3', maxInstances: 5 });

const FORM_WEBHOOK_SECRET = defineSecret('FORM_WEBHOOK_SECRET');
const TEAM_DOC = db.collection('config').doc('team');
const DEFAULT_PEOPLE = ['멤버1', '멤버2', '멤버3', '멤버4', '멤버5'];

function kstDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

async function getPeople() {
  const snap = await TEAM_DOC.get();
  const people = snap.exists ? snap.data().people : null;
  return Array.isArray(people) && people.length === 5 ? people : DEFAULT_PEOPLE;
}

async function getAllDays() {
  const snap = await db.collection('days').orderBy('date', 'asc').get();
  return snap.docs.map((d) => d.data());
}

async function getAbsencePlan(date) {
  const snap = await db.collection('absencePlan').doc(date).get();
  return snap.exists ? snap.data().people || [] : [];
}

async function isHoliday(date) {
  const snap = await db.collection('holidays').doc(date).get();
  return snap.exists;
}

async function getExtraSeats(date) {
  const snap = await db.collection('extraSeats').doc(date).get();
  return snap.exists ? snap.data().count || 0 : 0;
}

// 범위(startDate~endDate, 양끝 포함)에서 주말을 제외한 날짜 배열을 만든다.
function workdayRange(startDate, endDate) {
  const dates = [];
  for (let d = startDate; d <= endDate; d = assign.offsetDate(d, 1)) {
    if (!assign.isWeekend(d)) dates.push(d);
  }
  return dates;
}

async function computeAndSaveDay(targetDate, absentOverride) {
  if (assign.isWeekend(targetDate) || (await isHoliday(targetDate))) {
    throw new HttpsError('failed-precondition', '주말/휴무일에는 자리 배정을 생성할 수 없습니다.');
  }
  const people = await getPeople();
  const days = await getAllDays();
  const absent = absentOverride ?? (await getAbsencePlan(targetDate));
  const extraExternalCount = await getExtraSeats(targetDate);
  const { assignments, focusDay } = assign.generate(people, days, targetDate, absent, extraExternalCount);
  const record = {
    date: targetDate,
    absent,
    assignments,
    focusDay,
    extraExternalCount,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection('days').doc(targetDate).set(record);
  return record;
}

// ── Callable: 팀원 이름 저장 ─────────────────────────────────────────────
exports.savePeople = onCall((req) => {
  const people = req.data?.people;
  if (!Array.isArray(people) || people.length !== 5 || people.some((p) => !p || !String(p).trim())) {
    throw new HttpsError('invalid-argument', '팀원 5명의 이름을 모두 입력해주세요.');
  }
  return TEAM_DOC.set({ people: people.map((p) => String(p).trim()) }).then(() => ({ ok: true }));
});

// ── Callable: 특정 날짜 부재 토글 (캘린더/오늘/내일 탭에서 사용) ─────────
exports.setAbsence = onCall(async (req) => {
  const { date, person, isAbsent } = req.data || {};
  if (!date || !person) throw new HttpsError('invalid-argument', 'date, person이 필요합니다.');
  const ref = db.collection('absencePlan').doc(date);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const people = snap.exists ? snap.data().people || [] : [];
    const set = new Set(people);
    if (isAbsent) set.add(person);
    else set.delete(person);
    if (set.size === 0) tx.delete(ref);
    else tx.set(ref, { people: [...set] });
  });
  return { ok: true };
});

// ── Callable: 기간(range) 동안 특정 팀원을 부재로 등록/해제 (캘린더 드래그 선택) ─
exports.setAbsenceRange = onCall(async (req) => {
  const { person, startDate, endDate, isAbsent } = req.data || {};
  if (!person || !startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'person, startDate, endDate가 필요합니다.');
  }
  const dates = workdayRange(startDate, endDate);
  const batch = db.batch();
  dates.forEach((date) => {
    const ref = db.collection('absencePlan').doc(date);
    const op = isAbsent ? admin.firestore.FieldValue.arrayUnion(person) : admin.firestore.FieldValue.arrayRemove(person);
    batch.set(ref, { people: op }, { merge: true });
  });
  await batch.commit();
  return { ok: true, count: dates.length };
});

// ── Callable: 기간(range) 동안 회사 휴무일(연휴 등) 등록/해제 (캘린더 드래그 선택) ─
exports.setHolidayRange = onCall(async (req) => {
  const { startDate, endDate, isHoliday: makeHoliday } = req.data || {};
  if (!startDate || !endDate) {
    throw new HttpsError('invalid-argument', 'startDate, endDate가 필요합니다.');
  }
  const dates = workdayRange(startDate, endDate);
  const batch = db.batch();
  dates.forEach((date) => {
    const holidayRef = db.collection('holidays').doc(date);
    if (makeHoliday) {
      batch.set(holidayRef, { holiday: true });
      batch.delete(db.collection('days').doc(date)); // 이미 배정이 있었다면 휴무일과 공존할 수 없으니 제거
    } else {
      batch.delete(holidayRef);
    }
  });
  await batch.commit();
  return { ok: true, count: dates.length };
});

// ── Callable: 특정 날짜의 임시 추가 외부좌석 개수 설정 (다른 팀 자리가 비어 여유가 생긴 날 등) ─
exports.setExtraSeats = onCall(async (req) => {
  const { date, count } = req.data || {};
  if (!date || typeof count !== 'number' || count < 0) {
    throw new HttpsError('invalid-argument', 'date, count(0 이상 숫자)가 필요합니다.');
  }
  const ref = db.collection('extraSeats').doc(date);
  if (count === 0) await ref.delete();
  else await ref.set({ count });
  return { ok: true };
});

// ── Callable: 특정 날짜 배정 생성/재생성 ─────────────────────────────────
exports.generateDay = onCall(async (req) => {
  const { date, absent } = req.data || {};
  if (!date) throw new HttpsError('invalid-argument', 'date가 필요합니다.');
  return computeAndSaveDay(date, absent);
});

// ── Callable: 특정 날짜 배정 초기화 ───────────────────────────────────────
exports.resetDay = onCall(async (req) => {
  const { date } = req.data || {};
  if (!date) throw new HttpsError('invalid-argument', 'date가 필요합니다.');
  await db.collection('days').doc(date).delete();
  return { ok: true };
});

// ── Callable: 전체 배정기록 + 부재계획 초기화 (팀원 명단은 유지) ─────────
exports.resetAllData = onCall(async () => {
  const batchDelete = async (col) => {
    const snap = await db.collection(col).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  };
  await Promise.all([batchDelete('days'), batchDelete('absencePlan'), batchDelete('holidays'), batchDelete('extraSeats')]);
  return { ok: true };
});

// ── Callable: 이 기기의 FCM 토큰을 팀원 한 명과 연결 (알림 받을 사람 등록) ─
exports.registerToken = onCall(async (req) => {
  const { person, token } = req.data || {};
  if (!person || !token) throw new HttpsError('invalid-argument', 'person, token이 필요합니다.');
  await db
    .collection('tokens')
    .doc(person)
    .set({ token, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

// ── HTTP: Google Form 응답을 Apps Script가 이 URL로 전달 (부재 계획 등록) ─
// 요청 형식: POST { person: "이름", dates: ["2026-07-10", "2026-07-11"] }
// 헤더: x-webhook-secret: <FORM_WEBHOOK_SECRET 값>
exports.absenceWebhook = onRequest({ secrets: [FORM_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.headers['x-webhook-secret'] !== FORM_WEBHOOK_SECRET.value()) {
    res.status(401).send('unauthorized');
    return;
  }
  const { person, dates } = req.body || {};
  if (!person || !Array.isArray(dates) || dates.length === 0) {
    res.status(400).send('person, dates(array)가 필요합니다.');
    return;
  }
  const batch = db.batch();
  dates.forEach((date) => {
    const ref = db.collection('absencePlan').doc(date);
    batch.set(ref, { people: admin.firestore.FieldValue.arrayUnion(person) }, { merge: true });
  });
  await batch.commit();
  res.status(200).send('ok');
});

// ── 스케줄: 평일 07:30 (KST) — 오늘 배정이 없으면 생성 후, 팀원별로 자리 푸시 발송 ─
exports.dailyAssignAndNotify = onSchedule({ schedule: '30 7 * * 1-5', timeZone: 'Asia/Seoul' }, async () => {
  const today = kstDateStr();
  if (await isHoliday(today)) {
    console.log(`${today}는 휴무일로 등록되어 있어 배정/알림을 건너뜁니다.`);
    return;
  }
  const existing = await db.collection('days').doc(today).get();
  const record = existing.exists ? existing.data() : await computeAndSaveDay(today);

  const tokensSnap = await db.collection('tokens').get();
  const tokenByPerson = {};
  tokensSnap.docs.forEach((d) => (tokenByPerson[d.id] = d.data().token));

  await Promise.all(
    Object.entries(record.assignments || {}).map(async ([person, seat]) => {
      const token = tokenByPerson[person];
      if (!token) return;
      const body = seat ? `오늘 자리는 [${seat}] 입니다.` : '오늘은 부재로 처리되었습니다.';
      try {
        await messaging.send({
          token,
          notification: { title: '🪑 오늘의 자리', body },
          webpush: { fcmOptions: { link: '/' } },
        });
      } catch (err) {
        console.error(`FCM 발송 실패 (${person}):`, err.message);
      }
    })
  );
});
