// 포커스룸 좌석 배정 알고리즘 (프론트엔드 <script> 와 Cloud Functions(Node) 양쪽에서 그대로 사용)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FocusAssign = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FOCUS_SEATS = ['포커스룸1', '포커스룸2'];
  const EXTERNAL_SEATS = ['외부1', '외부2', '외부3'];
  const ALL_SEATS = [...FOCUS_SEATS, ...EXTERNAL_SEATS];

  // toISOString()은 항상 UTC 기준이라 KST(UTC+9) 등 UTC가 아닌 시간대에서는
  // 날짜가 하루 밀리거나(자정 부근) projectRange의 while문이 끝나지 않는 무한루프로 이어질 수 있어
  // 로컬 캘린더 구성요소로 직접 문자열을 만든다.
  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function offsetDate(base, delta) {
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    return toDateStr(d);
  }

  function isWeekend(dateStr) {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    return dow === 0 || dow === 6;
  }

  // days: [{ date, absent:[...], assignments:{person:seat|null}, focusDay:{person:n} }, ...] (date 오름차순)
  function focusCount(days, beforeDate) {
    const c = {};
    days.forEach((day) => {
      if (day.date >= beforeDate) return;
      Object.entries(day.assignments || {}).forEach(([p, s]) => {
        if (s && FOCUS_SEATS.includes(s)) c[p] = (c[p] || 0) + 1;
      });
    });
    return c;
  }

  function lastFocusDate(days, person, beforeDate) {
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (d.date >= beforeDate) continue;
      if (FOCUS_SEATS.includes(d.assignments?.[person])) return d.date;
    }
    return null;
  }

  // people: 전체 팀원 이름 배열 (등록 순서 = 우선순위 tie-break 기준)
  // days: 지금까지의 배정 기록 (date 오름차순, targetDate 이전 기록만 사용)
  // targetDate: 'YYYY-MM-DD'
  // absent: 해당 날짜에 부재인 사람 이름 배열
  function generate(people, days, targetDate, absent = []) {
    const present = people.filter((p) => !absent.includes(p));
    const assignments = {};
    const focusDay = {};
    const taken = new Set();
    absent.forEach((p) => (assignments[p] = null));

    // 주말/휴무일은 애초에 days에 기록을 남기지 않으므로, "어제 날짜"가 아니라
    // targetDate 이전의 가장 최근 근무일 기록을 찾는다 (자연스럽게 주말·연휴를 건너뛰게 됨).
    const priorDays = days.filter((d) => d.date < targetDate).sort((a, b) => b.date.localeCompare(a.date));
    const prevRec = priorDays[0];

    if (!prevRec) {
      FOCUS_SEATS.forEach((seat, i) => {
        if (present[i] !== undefined) {
          assignments[present[i]] = seat;
          focusDay[present[i]] = 1;
          taken.add(seat);
        }
      });
      EXTERNAL_SEATS.forEach((seat, i) => {
        const p = present[i + FOCUS_SEATS.length];
        if (p !== undefined) {
          assignments[p] = seat;
          taken.add(seat);
        }
      });
      return { assignments, focusDay };
    }

    const stayFocus = [];
    const leaveFocus = [];
    present.forEach((p) => {
      const s = prevRec.assignments?.[p];
      if (s && FOCUS_SEATS.includes(s)) {
        ((prevRec.focusDay?.[p] || 1) < 2 ? stayFocus : leaveFocus).push(p);
      }
    });

    stayFocus.forEach((p) => {
      const s = prevRec.assignments[p];
      assignments[p] = s;
      focusDay[p] = 2;
      taken.add(s);
    });

    const freeFocus = FOCUS_SEATS.filter((s) => !taken.has(s));
    const needAssign = present.filter((p) => !stayFocus.includes(p));
    const counts = focusCount(days, targetDate);
    // 우선순위: ① 포커스룸 누적 사용일 적은 순 → ② 마지막 사용일이 오래된 순 (null=한번도안씀=최우선) → ③ 등록 순서
    const byUsage = [...needAssign].sort((a, b) => {
      const ca = counts[a] || 0;
      const cb = counts[b] || 0;
      if (ca !== cb) return ca - cb;
      const la = lastFocusDate(days, a, targetDate);
      const lb = lastFocusDate(days, b, targetDate);
      if (!la && !lb) return people.indexOf(a) - people.indexOf(b);
      if (!la) return -1;
      if (!lb) return 1;
      return la.localeCompare(lb);
    });
    const gotFocus = [];
    freeFocus.forEach((seat, i) => {
      if (byUsage[i] !== undefined) {
        assignments[byUsage[i]] = seat;
        focusDay[byUsage[i]] = 1;
        taken.add(seat);
        gotFocus.push(byUsage[i]);
      }
    });

    const needExt = needAssign.filter((p) => !gotFocus.includes(p));
    const freeExt = EXTERNAL_SEATS.filter((s) => !taken.has(s));
    const unplaced = [];
    needExt.forEach((p) => {
      const prev = prevRec.assignments?.[p];
      if (prev && EXTERNAL_SEATS.includes(prev) && freeExt.includes(prev)) {
        assignments[p] = prev;
        freeExt.splice(freeExt.indexOf(prev), 1);
      } else {
        unplaced.push(p);
      }
    });
    unplaced.forEach((p) => {
      let best = null;
      for (let i = days.length - 1; i >= 0; i--) {
        const d = days[i];
        if (d.date >= targetDate) continue;
        const s = d.assignments?.[p];
        if (s && EXTERNAL_SEATS.includes(s) && freeExt.includes(s)) {
          best = s;
          break;
        }
      }
      const seat = best || freeExt[0] || null;
      if (seat) {
        assignments[p] = seat;
        freeExt.splice(freeExt.indexOf(seat), 1);
      }
    });

    return { assignments, focusDay };
  }

  // 이미 확정된 기록(days)에 없는 미래 날짜들을 순서대로 이어서 시뮬레이션 (달력 예측용)
  // absencePlanFor(dateStr) => 그 날짜의 부재자 배열을 반환하는 함수
  // isHolidayFor(dateStr) => 그 날짜가 회사 휴무일(연휴 등)인지 반환하는 함수 (생략 가능)
  function projectRange(people, days, fromDate, toDate, absencePlanFor, isHolidayFor) {
    const timeline = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const projected = [];
    let cursor = fromDate;
    while (cursor <= toDate) {
      const existing = timeline.find((d) => d.date === cursor);
      const holiday = isWeekend(cursor) || !!(isHolidayFor && isHolidayFor(cursor));
      if (existing) {
        projected.push({ ...existing, projected: false, offDay: false });
      } else if (holiday) {
        // timeline에는 추가하지 않는다 — 근무일이 아닌 날은 "이전 근무일" 탐색에서 자연스럽게 건너뛰어야 하기 때문.
        projected.push({ date: cursor, offDay: true, weekend: isWeekend(cursor), assignments: {}, focusDay: {}, absent: [] });
      } else {
        const absent = absencePlanFor(cursor) || [];
        const { assignments, focusDay } = generate(people, timeline, cursor, absent);
        const rec = { date: cursor, absent, assignments, focusDay, offDay: false };
        timeline.push(rec); // 다음 근무일 예측이 이어서 참조할 수 있도록 누적
        projected.push({ ...rec, projected: true });
      }
      cursor = offsetDate(cursor, 1);
    }
    return projected;
  }

  return {
    FOCUS_SEATS,
    EXTERNAL_SEATS,
    ALL_SEATS,
    toDateStr,
    offsetDate,
    isWeekend,
    focusCount,
    lastFocusDate,
    generate,
    projectRange,
  };
});
