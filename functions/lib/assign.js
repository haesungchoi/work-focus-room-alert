// 포커스룸 좌석 배정 알고리즘 — public/js/assign.js 와 동일 파일 (Functions 배포 패키지에 포함시키려고 복사본 유지)
// public/js/assign.js 를 고치면 이 파일도 동일하게 반영할 것
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FocusAssign = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FOCUS_SEATS = ['포룸 S98', '포룸 S97']; // 실제 호실 번호 정정: 포룸 S7→S108→S98, 포룸 S8→S107→S97
  // 정정 이전 기록과의 호환용 — 새 배정에는 쓰지 않고, 옛 이름이 남아있는 기록을 판별/표시할 때만 새 이름으로 매핑해 쓴다.
  // (같은 자리끼리 나란히 매핑: 첫 번째 자리 S7→S108→S98, 두 번째 자리 S8→S107→S97)
  const LEGACY_FOCUS_SEAT_MAP = {
    '포룸 S7': '포룸 S98',
    '포룸 S108': '포룸 S98',
    '포룸 S8': '포룸 S97',
    '포룸 S107': '포룸 S97',
  };
  const EXTERNAL_SEATS = ['S45', 'S42', 'S27'];

  function isFocusSeat(seat) {
    return FOCUS_SEATS.includes(seat) || seat in LEGACY_FOCUS_SEAT_MAP;
  }

  // 옛 이름으로 저장된 기록도 항상 현재 호실 이름으로 통일해 돌려준다 — 화면에 옛 이름과 새 이름이
  // 서로 다른 좌석 카드로 따로 표시되는 것을 막기 위함 (카운트/화면 표시 모두 이 함수를 거쳐 통일).
  function canonicalSeat(seat) {
    return LEGACY_FOCUS_SEAT_MAP[seat] || seat;
  }

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

  // dateStr 다음으로 가장 가까운 근무일을 찾는다 (주말/휴무일은 건너뜀).
  function nextWorkday(dateStr, isHolidayFor) {
    let d = offsetDate(dateStr, 1);
    while (isWeekend(d) || (isHolidayFor && isHolidayFor(d))) d = offsetDate(d, 1);
    return d;
  }

  // 기본 외부 좌석(외부1~3)에 그날그날 임시로 늘어난 자리(외부4, 외부5, ...)를 덧붙인다.
  // 이 자리는 외부 좌석의 원래 사용자(우리 팀 5명이 아닌 다른 사람)가 부재해 생기는 여유분으로,
  // 늘어난 만큼 아래 overflow 계산에 반영되어 포커스룸 신규 배정보다 먼저 채워진다 (외부 우선 원칙, 가이드 운영규칙 1).
  function buildExternalSeats(extraCount = 0) {
    if (!extraCount) return EXTERNAL_SEATS;
    const extra = Array.from({ length: extraCount }, (_, i) => `외부${EXTERNAL_SEATS.length + i + 1}`);
    return [...EXTERNAL_SEATS, ...extra];
  }

  // days: [{ date, absent:[...], assignments:{person:seat|null}, focusDay:{person:n} }, ...] (date 오름차순)
  function focusCount(days, beforeDate) {
    const c = {};
    days.forEach((day) => {
      if (day.date >= beforeDate) return;
      Object.entries(day.assignments || {}).forEach(([p, s]) => {
        if (s && isFocusSeat(s)) c[p] = (c[p] || 0) + 1;
      });
    });
    return c;
  }

  function lastFocusDate(days, person, beforeDate) {
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (d.date >= beforeDate) continue;
      if (isFocusSeat(d.assignments?.[person])) return d.date;
    }
    return null;
  }

  // people: 전체 팀원 이름 배열 (등록 순서 = 우선순위 tie-break 기준)
  // days: 지금까지의 배정 기록 (date 오름차순, targetDate 이전 기록만 사용)
  // targetDate: 'YYYY-MM-DD'
  // absent: 해당 날짜에 부재인 사람 이름 배열
  // extraExternalCount: 그날 임시로 늘어난 외부 좌석 개수 (기본 0)
  // nextAbsent: 다음 근무일에 부재 예정인 사람 이름 배열 (알고 있다면) — 포커스룸 좌석을 고를 때
  // 참고용으로만 쓰인다 (아래 byChurnAwareUsage 참고)
  function generate(people, days, targetDate, absent = [], extraExternalCount = 0, nextAbsent = []) {
    const externalSeats = buildExternalSeats(extraExternalCount);
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
      // 첫 배정일이라도 외부 우선 원칙은 동일하게 적용한다 — 외부 좌석만으로 다 앉힐 수 있으면
      // 포커스룸은 초과 인원 수만큼만 채운다 (present.length 만큼 무조건 포커스룸부터 채우지 않는다).
      const overflow = Math.max(0, present.length - externalSeats.length);
      const focusCount = Math.min(FOCUS_SEATS.length, overflow);
      FOCUS_SEATS.slice(0, focusCount).forEach((seat, i) => {
        assignments[present[i]] = seat;
        focusDay[present[i]] = 1;
        taken.add(seat);
      });
      externalSeats.forEach((seat, i) => {
        const p = present[i + focusCount];
        if (p !== undefined) {
          assignments[p] = seat;
          taken.add(seat);
        }
      });
      return { assignments, focusDay };
    }

    const focusEligible = []; // 어제 포커스룸 1일차 — 오늘 2일차로 유지될 수 있는 후보
    const focusMustLeave = []; // 어제 포커스룸 2일차 — 오늘은 무조건 나가야 함
    present.forEach((p) => {
      const s = prevRec.assignments?.[p];
      if (s && isFocusSeat(s)) {
        ((prevRec.focusDay?.[p] || 1) < 2 ? focusEligible : focusMustLeave).push(p);
      }
    });

    const counts = focusCount(days, targetDate);
    // 우선순위: ① 포커스룸 누적 사용일 적은 순 → ② 마지막 사용일이 오래된 순 (null=한번도안씀=최우선) → ③ 등록 순서
    const byUsageSort = (a, b) => {
      const ca = counts[a] || 0;
      const cb = counts[b] || 0;
      if (ca !== cb) return ca - cb;
      const la = lastFocusDate(days, a, targetDate);
      const lb = lastFocusDate(days, b, targetDate);
      if (!la && !lb) return people.indexOf(a) - people.indexOf(b);
      if (!la) return -1;
      if (!lb) return 1;
      return la.localeCompare(lb);
    };
    // 다음 근무일에 부재 예정인 사람을 포커스룸 후보 중 최우선으로 둔다 — 그 사람은 내일 어차피
    // 자리가 필요 없으니, 오늘 포커스룸에 넣어도 내일 "필요 인원이 줄어 누군가를 억지로 내보내야
    // 하는" 상황 자체가 생기지 않는다. 반대로 내일도 출근하는 사람을 넣으면, 그 사람이 오늘 하루만
    // 있다가 내일 다시 외부로 옮겨야 할 수 있다 — 불필요한 좌석 이동을 미리 피한다.
    const byChurnAwareUsage = (a, b) => {
      const aOut = nextAbsent.includes(a);
      const bOut = nextAbsent.includes(b);
      if (aOut !== bOut) return aOut ? -1 : 1;
      return byUsageSort(a, b);
    };

    // 외부 우선 원칙이 "2일 유지"보다 항상 우선한다 — 다른 사람의 결석 등으로 그날은 외부 좌석만으로
    // 충분해졌다면, 포커스룸 1일차였던 사람이라도 2일차를 못 채우고 그날은 외부로 내려간다.
    // 외부좌석을 비워둔 채로 포커스룸을 채우는 일이 없도록, 그날 실제로 필요한 만큼만 유지시킨다.
    const neededFocusSeats = Math.min(FOCUS_SEATS.length, Math.max(0, present.length - externalSeats.length));
    const sortedEligible = [...focusEligible].sort(byChurnAwareUsage);
    const stayFocus = sortedEligible.slice(0, neededFocusSeats);
    const bumpedFocus = sortedEligible.slice(neededFocusSeats); // 필요 인원이 줄어 2일차를 못 채우고 내려가는 사람
    const leaveFocus = [...focusMustLeave, ...bumpedFocus];

    stayFocus.forEach((p) => {
      const s = prevRec.assignments[p];
      assignments[p] = s;
      focusDay[p] = 2;
      taken.add(s);
    });

    const needAssign = present.filter((p) => !stayFocus.includes(p));
    const freeFocusCount = neededFocusSeats - stayFocus.length;
    const freeFocus = FOCUS_SEATS.filter((s) => !taken.has(s)).slice(0, freeFocusCount);
    // 좌석 이동을 최소화하기 위해, 포커스룸에 새로 들어갈 사람은 "현재 지키고 있는 외부 자리가 없는 사람"
    // (어제 결석했다가 오늘 복귀한 사람, 명단에 새로 추가된 사람 등)부터 우선 채운다.
    // 이미 외부 자리에 안정적으로 앉아있던 사람은, 복귀/신규 인원만으로는 초과 인원을 다 못 채워
    // 포커스룸 자리가 그래도 남을 때만 부득이하게 이동시킨다.
    const isReturning = (p) => !prevRec.assignments?.[p];
    const noSeatCandidates = needAssign.filter((p) => isReturning(p)).sort(byChurnAwareUsage);
    const stableCandidates = needAssign.filter((p) => !isReturning(p)).sort(byChurnAwareUsage);
    const byUsage = [...noSeatCandidates, ...stableCandidates];
    const gotFocus = [];
    freeFocus.forEach((seat, i) => {
      if (byUsage[i] !== undefined) {
        assignments[byUsage[i]] = seat;
        focusDay[byUsage[i]] = 1;
        taken.add(seat);
        gotFocus.push(byUsage[i]);
      }
    });

    // 포커스룸에서 나가는 사람은, 오늘 새로 들어가는 사람이 "어제" 앉아있던 외부자리를 그대로 물려받는다(스왑).
    // 이렇게 하면 원래 외부자리에 있던 다른 사람들은 전혀 건드리지 않고 그대로 유지된다 — 포커스룸 로테이션 때문에
    // 안정적으로 잘 앉아있던 외부자리 사람들의 자리가 불필요하게 바뀌는 것을 막는다.
    const leaveFocusQueue = [...leaveFocus];
    gotFocus.forEach((enteringPerson) => {
      if (leaveFocusQueue.length === 0) return;
      const prevSeat = prevRec.assignments?.[enteringPerson];
      if (prevSeat && externalSeats.includes(prevSeat) && !taken.has(prevSeat)) {
        const outgoingPerson = leaveFocusQueue.shift();
        assignments[outgoingPerson] = prevSeat;
        taken.add(prevSeat);
      }
    });

    // 아직 자리를 못 받은 사람들 — 대부분은 원래 외부자리에 계속 있던 사람들이라, 자기 자리를 그대로 유지시켜준다.
    const stillNeed = present.filter((p) => assignments[p] === undefined);
    const freeExt = externalSeats.filter((s) => !taken.has(s));
    const unplaced = [];
    stillNeed.forEach((p) => {
      const prev = prevRec.assignments?.[p];
      if (prev && externalSeats.includes(prev) && freeExt.includes(prev)) {
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
        if (s && externalSeats.includes(s) && freeExt.includes(s)) {
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
  // extraSeatsFor(dateStr) => 그 날짜의 임시 추가 외부좌석 개수를 반환하는 함수 (생략 가능)
  function projectRange(people, days, fromDate, toDate, absencePlanFor, isHolidayFor, extraSeatsFor) {
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
        const extraExternalCount = (extraSeatsFor && extraSeatsFor(cursor)) || 0;
        const nextAbsent = absencePlanFor(nextWorkday(cursor, isHolidayFor)) || [];
        const { assignments, focusDay } = generate(people, timeline, cursor, absent, extraExternalCount, nextAbsent);
        const rec = { date: cursor, absent, assignments, focusDay, offDay: false, extraExternalCount };
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
    isFocusSeat,
    canonicalSeat,
    toDateStr,
    offsetDate,
    isWeekend,
    nextWorkday,
    buildExternalSeats,
    focusCount,
    lastFocusDate,
    generate,
    projectRange,
  };
});
