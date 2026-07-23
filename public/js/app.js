import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import { getFirestore, doc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

// firebase-config.js (classic <script>, loaded before this module) provides window.FIREBASE_CONFIG
// assign.js (classic <script>, loaded before this module) provides window.FocusAssign
const { projectRange, offsetDate, toDateStr, isWeekend, buildExternalSeats, FOCUS_SEATS, isFocusSeat, canonicalSeat } = window.FocusAssign;

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
const functionsClient = getFunctions(app, 'asia-northeast3');

const callSetAbsence = httpsCallable(functionsClient, 'setAbsence');
const callSetAbsenceRange = httpsCallable(functionsClient, 'setAbsenceRange');
const callSetHolidayRange = httpsCallable(functionsClient, 'setHolidayRange');
const callSetExtraSeats = httpsCallable(functionsClient, 'setExtraSeats');
const callSetExtraSeatsRange = httpsCallable(functionsClient, 'setExtraSeatsRange');
const callGenerateDay = httpsCallable(functionsClient, 'generateDay');
const callResetDay = httpsCallable(functionsClient, 'resetDay');
const callResetAllData = httpsCallable(functionsClient, 'resetAllData');
const callSavePeople = httpsCallable(functionsClient, 'savePeople');

// ══ Constants ════════════════════════════════════════════════════════════════
const ICONS = { '포룸 S98': '🏠', '포룸 S97': '🏠', '포룸 S108': '🏠', '포룸 S107': '🏠', '포룸 S7': '🏠', '포룸 S8': '🏠', S45: '💼', S42: '💼', S27: '💼' };
const DAYS_KR = ['일', '월', '화', '수', '목', '금', '토'];
const MONTHS_KR = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
// 포커스룸(내부 좌석) 강조에 쓰는 액센트 블루(#3E6AE1)와 겹치지 않도록 고른 5명 구분용 색상
const P_COLORS = ['#6D28D9', '#0D9488', '#B45309', '#B3261E', '#475569'];
const DEFAULT_PEOPLE = ['멤버1', '멤버2', '멤버3', '멤버4', '멤버5'];

// ══ Reactive state (Firestore가 진실 공급원, 여기는 화면용 미러) ═══════════════
const state = { people: DEFAULT_PEOPLE, absencePlan: {}, days: [], holidays: {}, extraSeats: {} };
let configDocExists = false;
let bootedCount = 0;
const BOOT_TARGET = 5;

function onBootPiece() {
  bootedCount++;
  if (bootedCount === BOOT_TARGET) initOnboardingAndRender();
}

onSnapshot(doc(db, 'config', 'team'), (snap) => {
  configDocExists = snap.exists();
  const people = snap.exists() ? snap.data().people : null;
  state.people = Array.isArray(people) && people.length === 5 ? people : DEFAULT_PEOPLE;
  renderAll();
  onBootPiece();
});

onSnapshot(collection(db, 'absencePlan'), (snap) => {
  const m = {};
  snap.forEach((d) => (m[d.id] = d.data().people || []));
  state.absencePlan = m;
  renderAll();
  onBootPiece();
});

onSnapshot(collection(db, 'days'), (snap) => {
  const arr = [];
  snap.forEach((d) => arr.push(d.data()));
  arr.sort((a, b) => a.date.localeCompare(b.date));
  state.days = arr;
  renderAll();
  onBootPiece();
});

onSnapshot(collection(db, 'holidays'), (snap) => {
  const m = {};
  snap.forEach((d) => (m[d.id] = true));
  state.holidays = m;
  renderAll();
  onBootPiece();
});

onSnapshot(collection(db, 'extraSeats'), (snap) => {
  const m = {};
  snap.forEach((d) => (m[d.id] = d.data().count || 0));
  state.extraSeats = m;
  renderAll();
  onBootPiece();
});

function pColor(person) {
  const i = state.people.indexOf(person);
  return P_COLORS[i] ?? '#9ca3af';
}
function pInitial(person) { return person.slice(0, 1); }

// ══ Dates ════════════════════════════════════════════════════════════════════
function todayStr() { return toDateStr(new Date()); }
function fmtDate(s) {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS_KR[d.getDay()]})`;
}

// 'YYYY-MM-DD' → 해당 분기 키('2026-Q3')와 한글 라벨('2026년 3분기')
function quarterOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return { key: `${y}-Q${q}`, label: `${y}년 ${q}분기` };
}

function absencePlanFor(dateStr) { return state.absencePlan[dateStr] || []; }
function isHolidayFor(dateStr) { return !!state.holidays[dateStr]; }
function extraSeatsFor(dateStr) { return state.extraSeats[dateStr] || 0; }

function seatType(s) {
  if (!s) return 'absent';
  return isFocusSeat(s) ? 'focus' : 'external';
}

function findRecord(dateStr) { return state.days.find((d) => d.date === dateStr); }

// dateStr에 대한 배정을 반환한다. 이미 확정 기록이 있으면 그걸, 없으면 현재 부재계획 기준 실시간 예상치.
// dateStr만 단독으로 projectRange에 넘기면 그 이전의 미확정 미리보기 날짜들(예: 화요일을 볼 때 월요일 미리보기)이
// 히스토리에서 통째로 빠져, 포커스룸 2일 유지 같은 하루-이어달리기 상태가 끊겨 결과가 날마다 따로 노는 문제가 있었다.
// 그래서 마지막 확정 기록 다음날부터 dateStr까지 이어서 시뮬레이션한다 (달력 월간 미리보기와 동일한 방식).
function assignmentFor(dateStr) {
  const rec = findRecord(dateStr);
  if (rec) return { ...rec, projected: false };
  const lastConfirmed = state.days.map((d) => d.date).filter((d) => d < dateStr).pop();
  const fromDate = lastConfirmed ? offsetDate(lastConfirmed, 1) : dateStr;
  const projected = projectRange(state.people, state.days, fromDate, dateStr, absencePlanFor, isHolidayFor, extraSeatsFor);
  return projected[projected.length - 1];
}

// ══ Cards ════════════════════════════════════════════════════════════════════
function renderCards(assignments, focusDay, extraCount = 0) {
  // 좌석 호실 정정(포룸 S7→S108→S98, S8→S107→S97) 이전에 확정된 기록에는 옛 이름이 그대로 남아있을 수 있어,
  // 옛 이름은 canonicalSeat()로 새 이름과 합쳐서(카드가 따로 중복 표시되지 않게) 다룬다.
  const canonicalAssignments = {};
  Object.entries(assignments || {}).forEach(([p, s]) => { canonicalAssignments[p] = s ? canonicalSeat(s) : s; });
  const knownSeats = [...FOCUS_SEATS, ...buildExternalSeats(extraCount)];
  const usedSeats = Object.values(canonicalAssignments).filter(Boolean);
  const seats = [...new Set([...knownSeats, ...usedSeats])];
  return seats.map((seat) => {
    const person = Object.entries(canonicalAssignments).find(([, s]) => s === seat)?.[0];
    const type = seatType(seat);
    const isFocus = isFocusSeat(seat);
    const dn = person && focusDay?.[person];
    return `<div class="seat-card ${type}">
      <div class="seat-icon">${ICONS[seat] || (isFocus ? '🏠' : '💼')}</div>
      <div>
        <div class="seat-lbl">${seat} · ${isFocus ? '포커스룸 내부' : '외부 좌석'}</div>
        <div class="person-name">${person || '—'}</div>
        ${isFocus && dn ? `<span class="focus-badge">${dn}일차</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function absentToggles(dateStr, planned) {
  return state.people.map((p) => `
    <div class="person-row">
      <div class="pp" style="display:flex;align-items:center;gap:8px">
        <span class="person-avatar" style="background:${pColor(p)}">${pInitial(p)}</span>
        <span class="pname">${p}</span>
      </div>
      <label class="toggle">
        <input type="checkbox" ${planned.includes(p) ? 'checked' : ''} onchange="frToggleAbsence('${dateStr}','${p}',this.checked)">
        <span class="slider"></span>
      </label>
    </div>`).join('');
}

async function frToggleAbsence(dateStr, person, isAbsent) {
  try {
    await callSetAbsence({ date: dateStr, person, isAbsent });
  } catch (err) {
    alert('저장에 실패했습니다: ' + err.message);
  }
}
window.frToggleAbsence = frToggleAbsence;

// ══ Tab: 오늘 ════════════════════════════════════════════════════════════════
function renderToday() {
  const el = document.getElementById('tab-today');
  const today = todayStr();
  const rec = findRecord(today);
  const planned = absencePlanFor(today);

  if (!rec) {
    el.innerHTML = `
      <div class="gap16"></div>
      <div class="alert alert-info">오늘 자리가 아직 확정되지 않았습니다.</div>
      <div class="sec">오늘 부재 인원 <span style="font-weight:400;text-transform:none">(활성화 = 부재)</span></div>
      ${absentToggles(today, planned)}
      <div class="gap8"></div>
      <button class="btn btn-primary" onclick="frGenerateDay('${today}')">오늘 자리 배정 생성</button>`;
    return;
  }

  const absences = rec.absent || [];
  el.innerHTML = `
    <div class="gap16"></div>
    <div class="sec">${fmtDate(today)} 자리 배정</div>
    ${renderCards(rec.assignments, rec.focusDay, rec.extraExternalCount)}
    ${absences.length ? `<div class="sec">부재</div>${absences.map((p) => `
      <div class="seat-card absent">
        <div class="seat-icon" style="background:rgba(23,26,32,0.06)">✈️</div>
        <div><div class="seat-lbl">부재</div><div class="person-name">${p}</div></div>
      </div>`).join('')}` : ''}
    <div class="gap24"></div>
    <button class="btn btn-danger" onclick="frResetDay('${today}')">오늘 배정 초기화</button>`;
}

async function frGenerateDay(dateStr) {
  try { await callGenerateDay({ date: dateStr }); }
  catch (err) { alert('배정 생성에 실패했습니다: ' + err.message); }
}
window.frGenerateDay = frGenerateDay;

async function frResetDay(dateStr) {
  if (!confirm(`${fmtDate(dateStr)} 배정을 초기화하시겠습니까?`)) return;
  try { await callResetDay({ date: dateStr }); }
  catch (err) { alert('초기화에 실패했습니다: ' + err.message); }
}
window.frResetDay = frResetDay;

// ══ Tab: 내일 ════════════════════════════════════════════════════════════════
function renderTomorrow() {
  const el = document.getElementById('tab-tomorrow');
  const tom = offsetDate(todayStr(), 1);
  const existing = findRecord(tom);
  const planned = absencePlanFor(tom);
  const preview = assignmentFor(tom);

  el.innerHTML = `
    <div class="gap16"></div>
    ${existing
      ? `<div class="alert alert-ok">✅ 내일(${fmtDate(tom)}) 배정이 확정되었습니다.</div>`
      : `<div class="alert alert-info">내일(${fmtDate(tom)}) 예상 배정입니다. 부재 계획이 바뀌면 자동으로 갱신됩니다.</div>`}
    <div class="sec">내일 부재 인원 <span style="font-weight:400;text-transform:none">(활성화 = 부재)</span></div>
    ${absentToggles(tom, planned)}
    <div class="sec">${existing ? '확정 배정' : '예상 배정'}</div>
    ${renderCards(preview.assignments, preview.focusDay, preview.extraExternalCount)}
    <div class="gap8"></div>
    ${!existing
      ? `<button class="btn btn-primary" onclick="frGenerateDay('${tom}')">내일 배정 확정</button>`
      : `<button class="btn btn-danger" onclick="frResetDay('${tom}')">내일 배정 초기화</button>`}`;
}

// ══ Tab: 캘린더 (월간 — 개인별 스케줄 한눈에 보기) ═══════════════════════════
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let selectedDate = null;
let rangeSelection = null; // { start, end, active } — 여러 날짜를 드래그로 선택해 한 번에 부재/휴무일 등록할 때 사용

function minMaxOf(sel) {
  if (!sel) return null;
  return sel.start <= sel.end ? { min: sel.start, max: sel.end } : { min: sel.end, max: sel.start };
}
function rangeMinMax() { return minMaxOf(rangeSelection); }

// #tab-calendar는 renderCalendar()가 innerHTML만 갈아끼우고 엘리먼트 자체는 그대로라,
// 리스너를 한 번만 붙여두면 매 렌더링 후에도 계속 살아있다 (이벤트 위임 방식).
function setupCalendarDrag() {
  const container = document.getElementById('tab-calendar');
  container.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cal-cell[data-date]');
    if (!cell) return;
    rangeSelection = { start: cell.dataset.date, end: cell.dataset.date, active: true };
    selectedDate = null;
    renderCalendar();
  });
  container.addEventListener('pointermove', (e) => {
    if (!rangeSelection?.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest('.cal-cell[data-date]');
    if (!cell || cell.dataset.date === rangeSelection.end) return;
    rangeSelection.end = cell.dataset.date;
    renderCalendar();
  });
  window.addEventListener('pointerup', () => {
    if (!rangeSelection?.active) return;
    rangeSelection.active = false;
    if (rangeSelection.start === rangeSelection.end) {
      const d = rangeSelection.start;
      rangeSelection = null;
      selectCalDay(d);
    } else {
      renderCalendar();
    }
  });
}

function getCalPerson() {
  return localStorage.getItem('frCalPerson') || '__all__';
}
function setCalPerson(v) {
  localStorage.setItem('frCalPerson', v);
  renderCalendar();
}
window.setCalPerson = setCalPerson;

function renderCalendar() {
  const el = document.getElementById('tab-calendar');
  const today = todayStr();
  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const monthStart = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-01`;
  const monthEnd = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const projectedMonth = projectRange(state.people, state.days, monthStart, monthEnd, absencePlanFor, isHolidayFor, extraSeatsFor);
  const byDate = Object.fromEntries(projectedMonth.map((r) => [r.date, r]));

  const calPerson = getCalPerson();
  const personSelectHtml = `
    <select class="cal-person-select" onchange="setCalPerson(this.value)">
      <option value="__all__" ${calPerson === '__all__' ? 'selected' : ''}>👥 전체 인원 보기</option>
      ${state.people.map((p) => `<option value="${p}" ${calPerson === p ? 'selected' : ''}>${p}의 월별 스케줄</option>`).join('')}
    </select>`;

  const range = rangeMinMax();

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(calMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${calYear}-${mm}-${dd}`;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const isToday = dateStr === today;
    const isPast = dateStr < today;
    const isSel = dateStr === selectedDate;
    const isSun = dow === 0, isSat = dow === 6;
    const weekend = isSun || isSat;
    const holiday = isHolidayFor(dateStr);
    const offDay = weekend || holiday;
    const inRange = !!range && dateStr >= range.min && dateStr <= range.max;
    const rec = byDate[dateStr];
    const hasAssign = !!findRecord(dateStr);

    let personCls = '';
    let inner;
    if (offDay) {
      inner = `<div class="cal-num">${d}</div><div style="font-size:9px;color:var(--muted);margin-top:2px">${holiday ? '💤' : '휴무'}</div>`;
    } else if (calPerson !== '__all__' && rec) {
      const seat = canonicalSeat(rec.assignments?.[calPerson]);
      const t = seatType(seat);
      personCls = t === 'focus' ? ' pfocus' : t === 'external' ? ' pext' : ' pabsent';
      const label = seat || '부재';
      inner = `<div class="cal-num">${d}</div><div style="font-size:8px;font-weight:700;line-height:1.1;text-align:center">${label}</div>`;
    } else {
      const planned = absencePlanFor(dateStr);
      const dots = planned.map((p) => `<span class="cal-dot" style="background:${pColor(p)}" title="${p} 부재"></span>`).join('');
      inner = `<div class="cal-num">${d}</div>${hasAssign ? '<div class="cal-assigned-dot"></div>' : '<div style="height:4px;margin-bottom:1px"></div>'}<div class="cal-dots">${dots}</div>`;
    }

    cells += `
      <div class="cal-cell${personCls}${offDay ? ' offday' : ''}${holiday ? ' holiday' : ''}${weekend ? ' weekend' : ''}${isToday ? ' today' : ''}${isPast ? ' past' : ''}${isSel ? ' selected' : ''}${inRange ? ' range-selected' : ''}${isSun ? ' sun' : ''}${isSat ? ' sat' : ''}"
           data-date="${dateStr}">
        ${inner}
      </div>`;
  }

  const legendHtml = state.people.map((p, i) => `
    <span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11px">
      <span style="width:8px;height:8px;border-radius:50%;background:${P_COLORS[i]};display:inline-block;flex-shrink:0"></span>${p}
    </span>`).join('');

  const panelHtml = rangeSelection ? renderRangePanel() : (selectedDate ? renderDayPanel(selectedDate, byDate[selectedDate]) : '');
  const legendNote = calPerson === '__all__'
    ? '● 파란 점 = 포커스룸 배정 완료 &nbsp; 컬러 점 = 부재 계획 &nbsp; 날짜를 드래그하면 기간을 한 번에 등록할 수 있어요'
    : '파랑 = 포커스룸 · 회색 = 외부 좌석 · 옅은 회색 = 부재 (음영 없는 날은 아직 예측할 데이터가 없음)';

  el.innerHTML = `
    ${personSelectHtml}
    <div class="cal-header">
      <button class="cal-nav-btn" onclick="calPrev()">‹</button>
      <div class="cal-title">${calYear}년 ${MONTHS_KR[calMonth]}</div>
      <button class="cal-nav-btn" onclick="calNext()">›</button>
    </div>
    <div class="cal-weekdays">${DAYS_KR.map((d) => `<div class="cal-wd">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div style="margin-top:10px;padding:0 2px">${legendHtml}</div>
    <div style="margin-top:4px;font-size:10px;color:var(--muted);padding:0 2px">${legendNote}</div>
    ${panelHtml}`;
}

function renderRangePanel() {
  const { min, max } = rangeMinMax();
  const allDates = [];
  for (let c = min; c <= max; c = offsetDate(c, 1)) allDates.push(c);
  const workdays = allDates.filter((d) => !isWeekend(d));
  const personOptions = state.people.map((p) => `<option value="${p}">${p}</option>`).join('');

  return `
    <div class="day-panel">
      <div class="day-panel-title">🖐️ 선택한 기간: ${fmtDate(min)} ~ ${fmtDate(max)}</div>
      <div class="alert alert-info" style="font-size:11px">평일 ${workdays.length}일 선택됨 (주말 ${allDates.length - workdays.length}일은 자동 제외)</div>
      <div class="gap8"></div>
      <div class="input-group">
        <label class="input-lbl">부재로 등록할 팀원</label>
        <select class="input-field" id="rangePersonSelect">${personOptions}</select>
      </div>
      <button class="btn btn-primary" onclick="frConfirmRangeAbsence()">이 기간 부재로 등록</button>
      <button class="btn btn-secondary" onclick="frConfirmRangeHoliday()">💤 회사 휴무일(연휴 등)로 등록</button>
      <button class="btn btn-secondary" onclick="frCancelRange()">취소</button>
    </div>`;
}

async function frConfirmRangeAbsence() {
  const person = document.getElementById('rangePersonSelect')?.value;
  const range = rangeMinMax();
  if (!person || !range) return;
  try {
    await callSetAbsenceRange({ person, startDate: range.min, endDate: range.max, isAbsent: true });
    rangeSelection = null;
    renderCalendar();
  } catch (err) {
    alert('부재 등록에 실패했습니다: ' + err.message);
  }
}
window.frConfirmRangeAbsence = frConfirmRangeAbsence;

async function frConfirmRangeHoliday() {
  const range = rangeMinMax();
  if (!range) return;
  if (!confirm(`${fmtDate(range.min)} ~ ${fmtDate(range.max)} 기간을 회사 휴무일로 등록할까요?\n이미 배정이 확정된 날짜가 있다면 함께 삭제됩니다.`)) return;
  try {
    await callSetHolidayRange({ startDate: range.min, endDate: range.max, isHoliday: true });
    rangeSelection = null;
    renderCalendar();
  } catch (err) {
    alert('휴무일 등록에 실패했습니다: ' + err.message);
  }
}
window.frConfirmRangeHoliday = frConfirmRangeHoliday;

function frCancelRange() {
  rangeSelection = null;
  renderCalendar();
}
window.frCancelRange = frCancelRange;

async function frRemoveHoliday(dateStr) {
  try {
    await callSetHolidayRange({ startDate: dateStr, endDate: dateStr, isHoliday: false });
  } catch (err) {
    alert('휴무일 해제에 실패했습니다: ' + err.message);
  }
}
window.frRemoveHoliday = frRemoveHoliday;

async function frMarkDayHoliday(dateStr) {
  if (!confirm(`${fmtDate(dateStr)}을(를) 회사 휴무일로 등록할까요?\n이미 배정이 확정되어 있다면 함께 삭제됩니다.`)) return;
  try {
    await callSetHolidayRange({ startDate: dateStr, endDate: dateStr, isHoliday: true });
  } catch (err) {
    alert('휴무일 등록에 실패했습니다: ' + err.message);
  }
}
window.frMarkDayHoliday = frMarkDayHoliday;

async function frAdjustExtraSeats(dateStr, delta) {
  const next = Math.max(0, Math.min(5, extraSeatsFor(dateStr) + delta));
  try {
    await callSetExtraSeats({ date: dateStr, count: next });
  } catch (err) {
    alert('추가 좌석 설정에 실패했습니다: ' + err.message);
  }
}
window.frAdjustExtraSeats = frAdjustExtraSeats;

// monthRec: renderCalendar()가 이미 달력 한 달 전체를 이어서 계산해둔 결과(byDate[dateStr]).
// 여기서 다시 assignmentFor(dateStr)로 독립 계산하면 그 앞뒤 미확정 날짜들과 끊어진 결과가 나올 수 있어
// (확정된 날짜가 하나도 없을 때 특히 심함), 항상 monthRec을 우선 사용하고 없을 때만 폴백한다.
function renderDayPanel(dateStr, monthRec) {
  const weekend = isWeekend(dateStr);
  const holiday = isHolidayFor(dateStr);
  if (weekend || holiday) {
    return `
      <div class="day-panel">
        <div class="day-panel-title">📅 ${fmtDate(dateStr)}</div>
        <div class="alert alert-info">${weekend ? '주말은 근무일이 아니라 좌석을 배정하지 않습니다.' : '💤 회사 휴무일로 등록된 날짜라 좌석을 배정하지 않습니다.'}</div>
        ${holiday ? `<div class="gap8"></div><button class="btn btn-secondary" onclick="frRemoveHoliday('${dateStr}')">휴무일 해제</button>` : ''}
      </div>`;
  }

  const planned = absencePlanFor(dateStr);
  const rec = findRecord(dateStr);
  const today = todayStr();
  const isFuture = dateStr >= today;
  const preview = rec ? null : (monthRec || assignmentFor(dateStr));
  const extraCount = extraSeatsFor(dateStr);

  const extraSeatsSection = `
    <div class="sec" style="margin-top:0">추가 외부 좌석 <span style="font-weight:400;text-transform:none">(다른 팀 자리 여유가 생긴 날 등)</span></div>
    <div class="extra-seats-row">
      <button class="cal-nav-btn" onclick="frAdjustExtraSeats('${dateStr}',-1)">−</button>
      <span class="extra-seats-count">${extraCount === 0 ? '기본 3자리' : `+${extraCount} (총 ${3 + extraCount}자리)`}</span>
      <button class="cal-nav-btn" onclick="frAdjustExtraSeats('${dateStr}',1)">+</button>
    </div>`;

  const toggleRows = state.people.map((p) => `
    <div class="day-panel-person">
      <div class="pp">
        <span class="person-avatar" style="background:${pColor(p)}">${pInitial(p)}</span>
        <span style="font-size:14px;font-weight:600">${p}</span>
      </div>
      <label class="toggle">
        <input type="checkbox" ${planned.includes(p) ? 'checked' : ''} onchange="frToggleAbsence('${dateStr}','${p}',this.checked)">
        <span class="slider"></span>
      </label>
    </div>`).join('');

  let assignSection = '';
  const record = rec || preview;
  if (record) {
    const rows = state.people.map((p) => {
      const s = canonicalSeat(record.assignments?.[p]);
      const type = seatType(s);
      const fd = record.focusDay?.[p];
      return `<div class="day-assign-row">
        <span class="day-assign-badge ${type}">${s || '부재'}${fd ? ` ${fd}일차` : ''}</span>
        <span style="font-size:13px">${p}</span>
      </div>`;
    }).join('');
    assignSection = `<div class="sec" style="margin-top:14px">${rec ? '확정 배정' : '예상 배정 (미확정)'}</div>${rows}
      ${rec
        ? `<div class="gap8"></div><button class="btn btn-danger" onclick="frResetDay('${dateStr}')">이 날짜 배정 초기화</button>`
        : (isFuture ? `<div class="gap8"></div><button class="btn btn-secondary" onclick="frGenerateDay('${dateStr}')">이 날짜로 지금 확정하기</button>` : '')}`;
  }

  return `
    <div class="day-panel">
      <div class="day-panel-title">📅 ${fmtDate(dateStr)}</div>
      ${extraSeatsSection}
      <div class="sec">부재 계획 <span style="font-weight:400;text-transform:none">(활성화 = 부재 예정)</span></div>
      ${toggleRows}
      ${assignSection}
      <div class="gap8"></div>
      <button class="btn btn-secondary" onclick="frMarkDayHoliday('${dateStr}')">💤 이 날짜를 회사 휴무일(연휴 등)로 등록</button>
    </div>`;
}

function selectCalDay(dateStr) {
  selectedDate = selectedDate === dateStr ? null : dateStr;
  renderCalendar();
}
window.selectCalDay = selectCalDay;
// 캘린더/추가석 탭이 월 이동 상태(calYear/calMonth)를 공유하므로, 현재 보이는 탭을 다시 그린다.
function resetCalSelections() {
  selectedDate = null; rangeSelection = null;
  extraSelectedDate = null; extraRangeSelection = null;
}
function calPrev() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } resetCalSelections(); RENDERERS[activeTab]?.(); }
function calNext() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } resetCalSelections(); RENDERERS[activeTab]?.(); }
window.calPrev = calPrev;
window.calNext = calNext;

// ══ Tab: 추가석 (기간 드래그로 임시 추가 외부좌석 한 번에 등록) ══════════════════
let extraSelectedDate = null;
let extraRangeSelection = null;
let extraRangeCount = 0; // 범위 적용 패널에서 조정 중인 값 (드래그 시작 시 그 날짜의 현재 값으로 초기화)

function setupExtraSeatsDrag() {
  const container = document.getElementById('tab-extraseats');
  container.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cal-cell[data-date]');
    if (!cell) return;
    extraRangeSelection = { start: cell.dataset.date, end: cell.dataset.date, active: true };
    extraRangeCount = extraSeatsFor(cell.dataset.date);
    extraSelectedDate = null;
    renderExtraSeatsTab();
  });
  container.addEventListener('pointermove', (e) => {
    if (!extraRangeSelection?.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest('.cal-cell[data-date]');
    if (!cell || cell.dataset.date === extraRangeSelection.end) return;
    extraRangeSelection.end = cell.dataset.date;
    renderExtraSeatsTab();
  });
  window.addEventListener('pointerup', () => {
    if (!extraRangeSelection?.active) return;
    extraRangeSelection.active = false;
    if (extraRangeSelection.start === extraRangeSelection.end) {
      const d = extraRangeSelection.start;
      extraRangeSelection = null;
      selectExtraDay(d);
    } else {
      renderExtraSeatsTab();
    }
  });
}

function selectExtraDay(dateStr) {
  extraSelectedDate = extraSelectedDate === dateStr ? null : dateStr;
  renderExtraSeatsTab();
}
window.selectExtraDay = selectExtraDay;

function renderExtraSeatsTab() {
  const el = document.getElementById('tab-extraseats');
  const today = todayStr();
  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const range = minMaxOf(extraRangeSelection);

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(calMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${calYear}-${mm}-${dd}`;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const isToday = dateStr === today;
    const isPast = dateStr < today;
    const isSel = dateStr === extraSelectedDate;
    const isSun = dow === 0, isSat = dow === 6;
    const weekend = isSun || isSat;
    const holiday = isHolidayFor(dateStr);
    const offDay = weekend || holiday;
    const inRange = !!range && dateStr >= range.min && dateStr <= range.max;
    const count = extraSeatsFor(dateStr);

    let inner;
    if (offDay) {
      inner = `<div class="cal-num">${d}</div><div style="font-size:9px;color:var(--muted);margin-top:2px">${holiday ? '💤' : '휴무'}</div>`;
    } else {
      inner = `<div class="cal-num">${d}</div>${count > 0 ? `<div style="font-size:10px;font-weight:500;color:var(--accent)">+${count}</div>` : '<div style="height:12px"></div>'}`;
    }

    cells += `
      <div class="cal-cell${offDay ? ' offday' : ''}${holiday ? ' holiday' : ''}${weekend ? ' weekend' : ''}${isToday ? ' today' : ''}${isPast ? ' past' : ''}${isSel ? ' selected' : ''}${inRange ? ' range-selected' : ''}${isSun ? ' sun' : ''}${isSat ? ' sat' : ''}${count > 0 && !offDay ? ' pext' : ''}"
           data-date="${dateStr}">
        ${inner}
      </div>`;
  }

  const panelHtml = extraRangeSelection ? renderExtraRangePanel() : (extraSelectedDate ? renderExtraDayPanel(extraSelectedDate) : '');

  el.innerHTML = `
    <div class="gap16"></div>
    <div class="alert alert-info" style="font-size:11px">다른 팀 자리가 남아 추가 외부 좌석이 생긴 날짜를 드래그로 선택하면 기간 전체에 한 번에 등록할 수 있어요.</div>
    <div class="cal-header">
      <button class="cal-nav-btn" onclick="calPrev()">‹</button>
      <div class="cal-title">${calYear}년 ${MONTHS_KR[calMonth]}</div>
      <button class="cal-nav-btn" onclick="calNext()">›</button>
    </div>
    <div class="cal-weekdays">${DAYS_KR.map((d) => `<div class="cal-wd">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div style="margin-top:4px;font-size:10px;color:var(--muted);padding:0 2px">파란 숫자 = 그날 추가된 외부 좌석 수 · 날짜를 드래그하면 기간을 한 번에 등록할 수 있어요</div>
    ${panelHtml}`;
}

function renderExtraDayPanel(dateStr) {
  const weekend = isWeekend(dateStr);
  const holiday = isHolidayFor(dateStr);
  if (weekend || holiday) {
    return `
      <div class="day-panel">
        <div class="day-panel-title">📅 ${fmtDate(dateStr)}</div>
        <div class="alert alert-info">${weekend ? '주말은 근무일이 아니라 좌석을 배정하지 않습니다.' : '💤 회사 휴무일로 등록된 날짜라 좌석을 배정하지 않습니다.'}</div>
      </div>`;
  }
  const extraCount = extraSeatsFor(dateStr);
  return `
    <div class="day-panel">
      <div class="day-panel-title">📅 ${fmtDate(dateStr)}</div>
      <div class="extra-seats-row">
        <button class="cal-nav-btn" onclick="frAdjustExtraSeats('${dateStr}',-1)">−</button>
        <span class="extra-seats-count">${extraCount === 0 ? '기본 3자리' : `+${extraCount} (총 ${3 + extraCount}자리)`}</span>
        <button class="cal-nav-btn" onclick="frAdjustExtraSeats('${dateStr}',1)">+</button>
      </div>
    </div>`;
}

function renderExtraRangePanel() {
  const { min, max } = minMaxOf(extraRangeSelection);
  const allDates = [];
  for (let c = min; c <= max; c = offsetDate(c, 1)) allDates.push(c);
  const workdays = allDates.filter((d) => !isWeekend(d));

  return `
    <div class="day-panel">
      <div class="day-panel-title">🖐️ 선택한 기간: ${fmtDate(min)} ~ ${fmtDate(max)}</div>
      <div class="alert alert-info" style="font-size:11px">평일 ${workdays.length}일 선택됨 (주말 ${allDates.length - workdays.length}일은 자동 제외)</div>
      <div class="gap8"></div>
      <div class="extra-seats-row">
        <button class="cal-nav-btn" onclick="frAdjustExtraRangeCount(-1)">−</button>
        <span class="extra-seats-count">${extraRangeCount === 0 ? '기본 3자리' : `+${extraRangeCount} (총 ${3 + extraRangeCount}자리)`}</span>
        <button class="cal-nav-btn" onclick="frAdjustExtraRangeCount(1)">+</button>
      </div>
      <button class="btn btn-primary" onclick="frConfirmExtraRange()">이 기간에 적용</button>
      <button class="btn btn-secondary" onclick="frCancelExtraRange()">취소</button>
    </div>`;
}

function frAdjustExtraRangeCount(delta) {
  extraRangeCount = Math.max(0, Math.min(5, extraRangeCount + delta));
  renderExtraSeatsTab();
}
window.frAdjustExtraRangeCount = frAdjustExtraRangeCount;

async function frConfirmExtraRange() {
  const range = minMaxOf(extraRangeSelection);
  if (!range) return;
  try {
    await callSetExtraSeatsRange({ startDate: range.min, endDate: range.max, count: extraRangeCount });
    extraRangeSelection = null;
    renderExtraSeatsTab();
  } catch (err) {
    alert('추가 좌석 등록에 실패했습니다: ' + err.message);
  }
}
window.frConfirmExtraRange = frConfirmExtraRange;

function frCancelExtraRange() {
  extraRangeSelection = null;
  renderExtraSeatsTab();
}
window.frCancelExtraRange = frCancelExtraRange;

// ══ Tab: 기록 ════════════════════════════════════════════════════════════════
// 분기별로 각자 포커스룸에 "새로 들어간" 횟수(연속 사용의 시작일, focusDay===1)를 센다.
function focusEntryStatsByQuarter() {
  const byQuarter = {};
  state.days.forEach((day) => {
    const { key, label } = quarterOf(day.date);
    if (!byQuarter[key]) byQuarter[key] = { label, counts: {} };
    Object.entries(day.focusDay || {}).forEach(([p, fd]) => {
      if (fd === 1) byQuarter[key].counts[p] = (byQuarter[key].counts[p] || 0) + 1;
    });
  });
  return byQuarter;
}

function renderFocusStats() {
  const byQuarter = focusEntryStatsByQuarter();
  const keys = Object.keys(byQuarter).sort().reverse();
  if (!keys.length) return '';

  const sections = keys.map((key) => {
    const { label, counts } = byQuarter[key];
    const values = state.people.map((p) => counts[p] || 0);
    const max = Math.max(1, ...values);
    const spread = Math.max(...values) - Math.min(...values);
    const balanced = spread <= 1;
    const rows = state.people.map((p, i) => {
      const v = counts[p] || 0;
      const pct = Math.round((v / max) * 100);
      return `
        <div class="focus-stat-row">
          <div class="focus-stat-name">
            <span class="person-avatar" style="background:${P_COLORS[i]};width:20px;height:20px;font-size:9px">${pInitial(p)}</span>
            <span>${p}</span>
          </div>
          <div class="focus-stat-bar-wrap"><div class="focus-stat-bar" style="width:${pct}%;background:${P_COLORS[i]}"></div></div>
          <div class="focus-stat-count">${v}회</div>
        </div>`;
    }).join('');
    return `
      <div class="focus-stat-quarter">
        <div class="focus-stat-qtitle">${label} <span class="focus-stat-balance ${balanced ? 'ok' : 'warn'}">${balanced ? '균형 잡힘' : `최대 ${spread}회 차이`}</span></div>
        ${rows}
      </div>`;
  }).join('');

  return `
    <div class="sec" style="margin-top:0">🏠 포커스룸 사용 횟수 (분기별)</div>
    <div class="alert alert-info" style="font-size:11px">분기마다 각자 포커스룸에 새로 들어간 횟수입니다. 숫자가 비슷할수록 공평하게 배분된 것이고, 새 분기가 시작되면 자동으로 항목이 추가됩니다.</div>
    ${sections}
    <div class="divider"></div>`;
}

function renderHistory() {
  const el = document.getElementById('tab-history');
  const sorted = [...state.days].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 21);
  const statsHtml = renderFocusStats();
  if (!sorted.length) {
    el.innerHTML = '<div class="gap16"></div>' + (statsHtml || `<div class="empty"><div class="ico">📅</div><p>아직 배정 기록이 없습니다.</p></div>`);
    return;
  }
  el.innerHTML = '<div class="gap16"></div>' + statsHtml + '<div class="sec" style="margin-top:0">최근 배정 기록</div>' + sorted.map((day) => `
    <div class="history-card">
      <div class="history-date">${fmtDate(day.date)}</div>
      ${state.people.map((p) => {
        const s = canonicalSeat(day.assignments?.[p]);
        const type = seatType(s);
        const fd = day.focusDay?.[p];
        return `<div class="history-row">
          <span class="chip ${type}">${s || '부재'}${fd ? ` ${fd}일차` : ''}</span>
          <span>${p}</span>
        </div>`;
      }).join('')}
    </div>`).join('');
}

// ══ Tab: 설정 ════════════════════════════════════════════════════════════════
function renderSettings() {
  const el = document.getElementById('tab-settings');

  el.innerHTML = `
    <div class="gap16"></div>
    <div class="sec">팀원 이름</div>
    ${state.people.map((p, i) => `
      <div class="input-group">
        <label class="input-lbl">
          <span class="pcolor-dot" style="background:${P_COLORS[i]}"></span>
          멤버 ${i + 1}
        </label>
        <input class="input-field" id="sp${i}" type="text" value="${p}" placeholder="이름 입력">
      </div>`).join('')}
    <div class="gap8"></div>
    <button class="btn btn-primary" onclick="frSavePeople()">저장</button>

    <div class="divider"></div>
    <div class="sec">데이터 관리</div>
    <div class="gap8"></div>
    <button class="btn btn-danger" onclick="frClearAll()">전체 배정 기록 초기화</button>`;
}

async function frSavePeople() {
  const people = state.people.map((_, i) => document.getElementById(`sp${i}`)?.value?.trim() || state.people[i]);
  try {
    await callSavePeople({ people });
    alert('저장되었습니다.');
  } catch (err) {
    alert('저장에 실패했습니다: ' + err.message);
  }
}
window.frSavePeople = frSavePeople;

async function frClearAll() {
  if (!confirm('모든 배정 기록과 부재 계획이 삭제됩니다.\n팀원 이름은 유지됩니다. 계속하시겠습니까?')) return;
  try {
    await callResetAllData();
    selectedDate = null;
    alert('초기화되었습니다.');
  } catch (err) {
    alert('초기화에 실패했습니다: ' + err.message);
  }
}
window.frClearAll = frClearAll;

// ══ Navigation ════════════════════════════════════════════════════════════════
const RENDERERS = { today: renderToday, tomorrow: renderTomorrow, calendar: renderCalendar, extraseats: renderExtraSeatsTab, history: renderHistory, settings: renderSettings };
let activeTab = 'calendar';

function switchTab(tab, btn) {
  activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach((e) => e.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  btn.classList.add('active');
  RENDERERS[tab]?.();
}
window.switchTab = switchTab;

function renderAll() {
  if (bootedCount < BOOT_TARGET) return; // 초기 로딩 끝나기 전에는 그리지 않음(깜빡임 방지)
  RENDERERS[activeTab]?.();
}

// ══ Onboarding ════════════════════════════════════════════════════════════════
function initOnboardingAndRender() {
  const overlay = document.getElementById('onboarding');
  if (configDocExists) {
    overlay.classList.add('hidden');
  } else {
    const fields = document.getElementById('onboardingFields');
    fields.innerHTML = DEFAULT_PEOPLE.map((_, i) => `
      <div class="input-group">
        <label class="input-lbl">
          <span class="pcolor-dot" style="background:${P_COLORS[i]}"></span>
          멤버 ${i + 1}
        </label>
        <input class="input-field" id="ob${i}" type="text" placeholder="이름 입력 (예: 홍길동)">
      </div>`).join('');
    overlay.classList.remove('hidden');
  }
  document.getElementById('headerDate').textContent = fmtDate(todayStr());
  document.querySelectorAll('.nav-tab').forEach((e) => e.classList.remove('active'));
  document.querySelector('.nav-tab[data-tab="calendar"]')?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach((e) => e.classList.remove('active'));
  document.getElementById('tab-calendar').classList.add('active');
  renderCalendar();
}

async function finishOnboarding() {
  const names = DEFAULT_PEOPLE.map((_, i) => document.getElementById(`ob${i}`)?.value?.trim());
  if (names.some((n) => !n)) { alert('모든 팀원 이름을 입력해주세요.'); return; }
  try {
    await callSavePeople({ people: names });
    document.getElementById('onboarding').classList.add('hidden');
  } catch (err) {
    alert('저장에 실패했습니다: ' + err.message);
  }
}
window.finishOnboarding = finishOnboarding;

setupCalendarDrag();
setupExtraSeatsDrag();

// ══ Service worker 등록 (PWA 설치용 앱 셸 캐싱) ═══════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/firebase-messaging-sw.js').catch((err) => console.error('SW 등록 실패:', err));
}
