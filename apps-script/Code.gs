/**
 * 부재(휴가) 계획 Google Form → Cloud Functions(absenceWebhook) 연동 스크립트.
 *
 * 설정 방법 (README-DEPLOY.md 참고):
 * 1. Google Form 생성. 질문 2개, 아래 제목과 "정확히" 똑같이 만들 것 (namedValues 매칭에 사용됨):
 *    - "이름" (드롭다운, 팀원 5명 이름)
 *    - "부재 예정일 (쉼표로 구분, 예: 2026-07-10, 2026-07-11)" (단답형)
 * 2. Form의 [응답] 탭에서 초록색 시트 아이콘을 눌러 연결된 스프레드시트 생성.
 * 3. 그 스프레드시트에서 확장 프로그램 > Apps Script 를 열고, 이 파일 내용을 붙여넣기.
 * 4. 아래 WEBHOOK_URL / WEBHOOK_SECRET 값을 실제 배포한 값으로 교체.
 * 5. 왼쪽 시계 아이콘(트리거) > 트리거 추가 > 이벤트 유형: "양식 제출 시" (onFormSubmit 함수) 로 등록.
 */

const WEBHOOK_URL = 'https://asia-northeast3-focus-room-alert.cloudfunctions.net/absenceWebhook';
// 실제 비밀값은 이 저장소가 공개(public)라서 커밋하지 않습니다.
// `firebase functions:secrets:access FORM_WEBHOOK_SECRET`으로 확인하거나, 대화 기록에서 확인해 여기에 채워넣으세요.
const WEBHOOK_SECRET = 'REPLACE_WITH_SAME_SECRET_AS_FIREBASE_FUNCTIONS_SECRET';

const NAME_QUESTION = '이름';
const DATES_QUESTION = '부재 예정일 (쉼표로 구분, 예: 2026-07-10, 2026-07-11)';

function onFormSubmit(e) {
  const values = e.namedValues || {};
  const person = (values[NAME_QUESTION] || [])[0];
  const rawDates = (values[DATES_QUESTION] || [])[0] || '';

  if (!person) {
    console.error('이름 응답을 찾지 못했습니다. Form 질문 제목이 NAME_QUESTION 상수와 일치하는지 확인하세요.');
    return;
  }

  const dates = parseDates(rawDates);
  if (dates.length === 0) {
    console.error('유효한 날짜를 찾지 못했습니다: ' + rawDates);
    return;
  }

  const res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-webhook-secret': WEBHOOK_SECRET },
    payload: JSON.stringify({ person, dates }),
    muteHttpExceptions: true,
  });

  console.log('webhook status: ' + res.getResponseCode() + ' body: ' + res.getContentText());
}

function parseDates(raw) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => DATE_RE.test(s));
}

/** Apps Script 편집기에서 이 함수를 직접 실행하면 webhook 연결을 테스트할 수 있습니다. */
function testWebhook() {
  onFormSubmit({
    namedValues: {
      [NAME_QUESTION]: ['테스트'],
      [DATES_QUESTION]: ['2026-08-01, 2026-08-02'],
    },
  });
}
