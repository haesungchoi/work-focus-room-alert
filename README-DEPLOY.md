# 배포 가이드

구조가 "브라우저 localStorage 정적 페이지" → "Firestore(공유 DB) + Cloud Functions(자동화) + PWA 푸시 알림"으로 바뀌었습니다.
아래 순서대로 진행하면 됩니다. Firebase 콘솔/Google 계정 관련 단계는 직접 웹 UI에서 클릭해야 하는 부분이라 사람이 해야 합니다.

## 0. 사전 확인 — 회사 네트워크에서 새 도메인이 열리는지 먼저 테스트

`github.io`가 막히는 이유가 "낯선 외부 도메인 차단"이라면 `*.web.app`(Firebase Hosting 기본 도메인)도 막힐 수 있습니다.
1번(Firebase 프로젝트 생성)까지만 먼저 진행해 아무 웹앱이나 `https://프로젝트ID.web.app` 로 배포해보고, 회사 와이파이에서 열리는지 확인해보는 걸 추천합니다. 안 열리면 회사 프록시 허용 목록에 추가를 요청하거나, 사내에서 열 필요가 없는 부분(알림 수신)과 열려야 하는 부분(Google Form 입력)을 구분해서 생각하면 됩니다 — Google Form/Sheets는 이미 업무에 쓰고 있을 가능성이 높아 대체로 열립니다.

## 1. Firebase 프로젝트 생성

1. https://console.firebase.google.com → "프로젝트 추가" → 프로젝트 이름 입력 (예: `focus-room`)
2. 프로젝트 설정 > "요금제" 를 **Blaze(종량제)** 로 업그레이드
   - Cloud Functions 예약 실행(Scheduler)과 외부 API 호출(Sheets/Form 연동)에는 Blaze가 필요합니다. 신용카드 등록은 필요하지만, 5명 규모 사용량은 무료 한도(Functions 월 200만 호출, Firestore 일 5만 읽기 등) 안에 들어와 실제 과금은 거의 발생하지 않습니다.
3. 왼쪽 메뉴 "Firestore Database" → 데이터베이스 만들기 → **프로덕션 모드** → 리전 `asia-northeast3 (서울)` 선택
4. 왼쪽 메뉴 "Cloud Messaging" 탭 → 사용 설정
5. 프로젝트 설정 > 클라우드 메시징 > "웹 구성" > "웹 푸시 인증서" > 키 쌍 생성 → 나오는 문자열이 VAPID 키
6. 프로젝트 설정 > 일반 > 내 앱 > `</>` (웹 앱 추가) → 앱 닉네임 아무거나 입력 → 나오는 `firebaseConfig` 객체 값을 복사

## 2. 설정 값 채워넣기

- [public/js/firebase-config.js](public/js/firebase-config.js) — 1-6의 `firebaseConfig` 값과 VAPID 키 붙여넣기
- [.firebaserc](.firebaserc) — `default` 값을 실제 Firebase 프로젝트 ID로 교체

## 3. firebase-tools 설치 및 로그인

```bash
npm install -g firebase-tools
firebase login
```

## 4. Cloud Functions 의존성 설치

```bash
cd functions
npm install
cd ..
```

## 5. Webhook 비밀값 설정 (Google Form → Cloud Functions 인증용)

임의의 긴 문자열을 하나 정해서(예: `openssl rand -hex 16` 결과)아래처럼 등록합니다.

```bash
firebase functions:secrets:set FORM_WEBHOOK_SECRET
```

프롬프트가 뜨면 정한 문자열을 붙여넣으세요. 이 값은 잠시 후 `apps-script/Code.gs`의 `WEBHOOK_SECRET`에도 똑같이 넣어야 합니다.

## 6. 배포

```bash
firebase deploy
```

Hosting / Firestore rules / Functions 가 한 번에 배포됩니다. 완료되면 터미널에 나오는 Hosting URL(`https://프로젝트ID.web.app`)로 접속해보세요.

배포 후 Firebase 콘솔 > Functions 탭에서 `absenceWebhook` 함수를 클릭하면 트리거 URL(`https://asia-northeast3-프로젝트ID.cloudfunctions.net/absenceWebhook`)이 보입니다. 이 값을 [apps-script/Code.gs](apps-script/Code.gs)의 `WEBHOOK_URL`에 넣으세요.

## 7. Google Form 만들기 (부재 일정 월 단위 입력)

1. https://forms.google.com 에서 새 양식 생성
2. 질문 2개를 **정확히 아래 제목 그대로** 추가 (Apps Script가 제목으로 응답을 찾습니다)
   - `이름` — 객관식 또는 드롭다운, 팀원 5명의 이름을 선택지로 등록
   - `부재 예정일 (쉼표로 구분, 예: 2026-07-10, 2026-07-11)` — 단답형. 팀원이 이번 달 부재 예정일을 한 번에 콤마로 구분해 입력
3. [응답] 탭 → 초록색 스프레드시트 아이콘 클릭 → "새 스프레드시트 만들기"로 연결
4. 생성된 스프레드시트에서 상단 메뉴 [확장 프로그램] > [Apps Script]
5. 기본 코드를 지우고 [apps-script/Code.gs](apps-script/Code.gs) 내용을 붙여넣기, `WEBHOOK_URL`/`WEBHOOK_SECRET` 값 채우기
6. 왼쪽 시계 아이콘(트리거) → [+ 트리거 추가] → 실행할 함수: `onFormSubmit`, 이벤트 유형: **양식 제출 시** → 저장 (계정 권한 승인 필요)
7. Apps Script 편집기에서 `testWebhook` 함수를 선택해 한 번 실행 → 정상이면 실행 로그에 `webhook status: 200` 표시. 이후 앱의 캘린더 탭에서 2026-08-01, 08-02가 "테스트"라는 이름으로 부재 표시되는지 확인 후 지워도 됩니다 (Firestore 콘솔에서 `absencePlan` 컬렉션 문서 직접 삭제, 또는 앱 캘린더에서 토글).
8. Form 링크를 팀원들에게 공유하고, 매달 초 "이번 달 부재 예정일 입력해주세요" 안내

## 8. 각자 기기에서 알림 켜기

**사내망이 아닌 곳(집 와이파이/모바일 데이터)에서** 접속해야 최초 설치·구독이 됩니다.

- **Android(Chrome)**: 사이트 접속 → 설정 탭 → "이 기기는 누구의 것인가요" 선택 → "평일 아침 알림 켜기" → 알림 권한 허용
- **iPhone(Safari)**: 반드시 먼저 공유 버튼 → "홈 화면에 추가"로 설치 → 홈 화면 아이콘으로 실행 → 설정 탭에서 알림 켜기 (Safari 브라우저 탭 상태에서는 iOS가 웹 푸시를 지원하지 않습니다)

이후에는 평일 07:30(KST)에 Cloud Scheduler가 자동으로 그날 배정을 계산하고 각자 기기로 "오늘 자리는 OOO 입니다" 알림을 보냅니다. 회사 와이파이가 그 사이트를 막고 있어도, 이미 설치된 알림은 폰이 인터넷에 연결돼 있으면 정상 수신됩니다.

## 9. 기존 GitHub Pages 정리

기존에 `work-focus-room` 저장소를 GitHub Pages로 서비스하고 있었다면, 저장소 Settings > Pages에서 비활성화하거나 안내 문구만 남겨두는 걸 추천합니다 (localStorage 기반 구버전이라 이제 팀 데이터와 무관합니다).

## 참고: 로컬에서 미리 보기

`public/js/firebase-config.js` 값을 채운 뒤에는 로컬 서버로 열어도 실제 Firestore/Functions에 그대로 연결됩니다 (파일을 `file://`로 직접 열면 서비스워커 등록이 안 되니 아래처럼 http 서버로 여세요).

```bash
cd public
python3 -m http.server 8080
# http://localhost:8080 접속
```
