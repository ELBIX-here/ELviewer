import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../../types";
import { useStats, dayKey, addDays, streaks, weekStreak, sumRange, readingSpeed, formatMinutes, READ_DAY_MS, type DayStat } from "../../store/stats";
import { useProgress } from "../../store/progress";
import { useLibrary } from "../../store/library";
import { useSettings } from "../../store/settings";
import { formatPct } from "../../lib/text";
import { IconBack } from "../Icons";

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);

function mondayOf(d: Date): Date {
  const r = addDays(d, -((d.getDay() + 6) % 7));
  r.setHours(0, 0, 0, 0);
  return r;
}

function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[(d.getDay() + 6) % 7]})`;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  value: string;
}

/** Tooltip positioned relative to the nearest `.viz-card`. */
function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
      <div className="viz-tip-title">{tip.title}</div>
      <div className="viz-tip-value">{tip.value}</div>
    </div>
  );
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const show = (e: React.MouseEvent, title: string, value: string) => {
    const r = cardRef.current!.getBoundingClientRect();
    const t = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ x: t.left + t.width / 2 - r.left, y: t.top - r.top, title, value });
  };
  return { tip, cardRef, show, hide: () => setTip(null) };
}

// ---------- goal ring + week strip (Apple Books style) ----------

function Ring({ value, size, stroke, label }: { value: number; size: number; stroke: number; label?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--viz-track)" strokeWidth={stroke} />
      {v > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={v >= 1 ? "var(--viz-good)" : "var(--viz-1)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      {label}
    </svg>
  );
}

function GoalCard({ days, goalMin, setGoal }: { days: Record<string, DayStat>; goalMin: number; setGoal: (m: number) => void }) {
  const today = new Date();
  const todayMs = days[dayKey(today)]?.ms ?? 0;
  const goalMs = goalMin * 60000;
  const monday = mondayOf(today);
  const todayIdx = (today.getDay() + 6) % 7;
  return (
    <div className="viz-card goal-card">
      <div className="goal-main">
        <Ring
          value={todayMs / goalMs}
          size={132}
          stroke={12}
          label={
            <>
              <text x="66" y="62" textAnchor="middle" className="ring-value">
                {Math.floor(todayMs / 60000)}
              </text>
              <text x="66" y="86" textAnchor="middle" className="ring-sub">
                / {goalMin}분
              </text>
            </>
          }
        />
        <div className="goal-text">
          <div className="card-label">오늘의 독서</div>
          <div className="goal-status">{todayMs >= goalMs ? "오늘 목표 달성!" : `목표까지 ${Math.max(1, Math.ceil((goalMs - todayMs) / 60000))}분`}</div>
          <div className="goal-edit">
            <span className="muted">하루 목표</span>
            <div className="stepper">
              <button onClick={() => setGoal(Math.max(5, goalMin - 5))}>−</button>
              <span>{goalMin}분</span>
              <button onClick={() => setGoal(Math.min(600, goalMin + 5))}>+</button>
            </div>
          </div>
        </div>
      </div>
      <div className="week-strip">
        {WEEKDAYS.map((w, i) => {
          const d = addDays(monday, i);
          const ms = days[dayKey(d)]?.ms ?? 0;
          const future = i > todayIdx;
          return (
            <div key={w} className={`week-day ${i === todayIdx ? "today" : ""}`} title={`${fmtDate(d)} · ${formatMinutes(ms)}`}>
              <Ring value={future ? 0 : ms / goalMs} size={34} stroke={4} />
              <span>{w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- KPI tiles ----------

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="viz-card tile-stat">
      <div className="card-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className={`tile-sub ${tone ?? ""}`}>{sub}</div>}
    </div>
  );
}

// ---------- calendar heatmap (Kindle / GitHub style) ----------

function levelOf(ms: number, goalMs: number): number {
  if (ms < READ_DAY_MS) return 0;
  if (ms < goalMs * 0.5) return 1;
  if (ms < goalMs) return 2;
  if (ms < goalMs * 2) return 3;
  return 4;
}

function Heatmap({ days, goalMin }: { days: Record<string, DayStat>; goalMin: number }) {
  const { tip, cardRef, show, hide } = useTip();
  const weeks = 53;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = addDays(mondayOf(today), -7 * (weeks - 1));
  const cell = 13;
  const gap = 3;
  const cols: { d: Date; ms: number }[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  let readDays = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, w * 7 + i);
      const ms = days[dayKey(d)]?.ms ?? 0;
      if (d <= today && ms >= READ_DAY_MS) readDays++;
      col.push({ d, ms });
    }
    const m = col[0].d.getMonth();
    if (m !== lastMonth) {
      if (w > 0 || col[0].d.getDate() <= 7) monthLabels.push({ col: w, label: MONTHS[m] });
      lastMonth = m;
    }
    cols.push(col);
  }
  const goalMs = goalMin * 60000;
  const width = weeks * (cell + gap);
  return (
    <div className="viz-card" ref={cardRef}>
      <div className="card-head">
        <div>
          <div className="card-title">독서 캘린더</div>
          <div className="card-sub">최근 1년 동안 {readDays}일 읽었습니다</div>
        </div>
        <div className="heat-legend">
          <span>적음</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={`heat-l${l}`} />
          ))}
          <span>많음</span>
        </div>
      </div>
      <div className="heat-scroll">
        <div className="heat-grid" style={{ width: width + 24 }}>
          <div className="heat-months" style={{ marginLeft: 24 }}>
            {monthLabels.map((m) => (
              <span key={m.col} style={{ left: m.col * (cell + gap) }}>
                {m.label}
              </span>
            ))}
          </div>
          <div style={{ display: "flex" }}>
            <div className="heat-wd">
              {WEEKDAYS.map((w, i) => (
                <span key={w} style={{ height: cell, marginBottom: gap, visibility: i % 2 === 0 ? "visible" : "hidden" }}>
                  {w}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap }}>
              {cols.map((col, ci) => (
                <div key={ci} style={{ display: "flex", flexDirection: "column", gap }}>
                  {col.map(({ d, ms }) =>
                    d > today ? (
                      <i key={d.getTime()} style={{ width: cell, height: cell }} />
                    ) : (
                      <i
                        key={d.getTime()}
                        className={`heat-cell heat-l${levelOf(ms, goalMs)}`}
                        style={{ width: cell, height: cell }}
                        onMouseEnter={(e) => show(e, fmtDate(d), ms >= READ_DAY_MS ? formatMinutes(ms) : "읽지 않음")}
                        onMouseLeave={hide}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- bar charts ----------

/** Column path with 4px rounded top corners anchored flat on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 30;
  const steps = [15, 30, 60, 90, 120, 180, 240, 360, 480, 720];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 120) * 120;
}

function BarChart({
  title,
  sub,
  values,
  labels,
  tipTitles,
  highlight,
  goal,
  labelEvery,
}: {
  title: string;
  sub: string;
  values: number[]; // minutes
  labels: string[];
  tipTitles: string[];
  highlight?: number;
  goal?: number;
  labelEvery: number;
}) {
  const { tip, cardRef, show, hide } = useTip();
  const W = 640;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const padT = 10;
  const max = niceMax(Math.max(...values, goal ?? 0));
  const n = values.length;
  const slot = (W - padL) / n;
  const bw = Math.max(3, slot - 2);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  return (
    <div className="viz-card" ref={cardRef}>
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{sub}</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="bar-svg" preserveAspectRatio="none" onMouseLeave={hide}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="axis-text">
              {t >= 60 ? `${+(t / 60).toFixed(1)}h` : `${t}m`}
            </text>
          </g>
        ))}
        {values.map((v, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const top = y(v);
          return (
            <g key={i}>
              <path d={barPath(x, top, bw, y(0) - top)} className={i === highlight ? "bar bar-hl" : "bar"} />
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="axis-text">
                  {labels[i]}
                </text>
              )}
              <rect
                x={padL + i * slot}
                y={padT}
                width={slot}
                height={H - padT - padB}
                fill="transparent"
                onMouseEnter={(e) => show(e, tipTitles[i], v > 0 ? formatMinutes(v * 60000) : "기록 없음")}
              />
            </g>
          );
        })}
        {goal != null && goal <= max && (
          <g>
            <line x1={padL} x2={W} y1={y(goal)} y2={y(goal)} className="goal-line" />
            <text x={W - 4} y={y(goal) - 5} textAnchor="end" className="goal-text-svg">
              목표 {goal}분
            </text>
          </g>
        )}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- page ----------

export function StatsView({ onBack, onOpen }: { onBack: () => void; onOpen: (e: Entry) => void }) {
  const { days, books, goalMin, setGoal } = useStats();
  const progress = useProgress((s) => s.progress);
  const entries = useLibrary((s) => s.entries);
  const theme = useSettings((s) => s.settings.theme);
  const light = theme === "light" || theme === "sepia";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const st = useMemo(() => streaks(days), [days]);
  const wk = useMemo(() => weekStreak(days), [days]);
  const monday = mondayOf(today);
  const thisWeek = sumRange(days, monday, 7);
  const lastWeek = sumRange(days, addDays(monday, -7), 7);
  const totalMs = Object.values(days).reduce((a, d) => a + d.ms, 0);
  const speed = readingSpeed(books);
  const year = today.getFullYear();
  const finishedThisYear = Object.values(books).filter((b) => b.finishedAt && new Date(b.finishedAt).getFullYear() === year).length;

  const last30 = useMemo(() => {
    const out: { d: Date; min: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = addDays(today, -i);
      out.push({ d, min: Math.round((days[dayKey(d)]?.ms ?? 0) / 60000) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const hours = useMemo(() => {
    const h = new Array(24).fill(0);
    for (let i = 0; i < 30; i++) {
      const ds = days[dayKey(addDays(today, -i))];
      if (ds) ds.hours.forEach((v, j) => (h[j] += v));
    }
    return h.map((v) => Math.round(v / 60000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);
  const peakHour = hours.indexOf(Math.max(...hours));

  const bookRows = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return Object.entries(books)
      .map(([id, b]) => {
        const p = progress[id];
        const pct = p?.pct ?? 0;
        const readDays = Object.values(days).filter((d) => (d.books[id] ?? 0) >= READ_DAY_MS).length;
        // Time left: by character speed for text, otherwise extrapolate this book's own pace.
        let left: number | null = null;
        if (pct < 0.995) {
          if (b.kind === "text" && speed && p?.totalChars) left = ((p.totalChars * (1 - pct)) / speed) * 60000;
          else if (pct >= 0.02 && b.ms > 60000) left = (b.ms / pct) * (1 - pct);
        }
        const entry = byId.get(id) ?? entries.find((e) => e.kind === "image" && e.dir === id);
        return { id, b, pct, readDays, left, entry };
      })
      .sort((a, z) => z.b.lastRead - a.b.lastRead);
  }, [books, days, progress, entries, speed]);

  const empty = totalMs === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className={`stats ${light ? "viz-light" : "viz-dark"}`}>
      <div className="stats-top">
        <button className="icon-btn" onClick={onBack} title="서재로 (Esc)">
          <IconBack />
        </button>
        <h1>읽기 통계</h1>
      </div>
      <div className="stats-body">
        {empty && (
          <div className="viz-card stats-empty">
            아직 기록이 없습니다. 책을 읽으면 읽은 시간과 속도가 여기에 쌓입니다.
            <span className="muted">(3분 동안 아무 조작이 없으면 자리를 비운 것으로 보고 기록을 멈춥니다)</span>
          </div>
        )}
        <div className="stats-row top">
          <GoalCard days={days} goalMin={goalMin} setGoal={setGoal} />
          <div className="tiles">
            <Tile label="연속 독서일" value={`${st.current}일`} sub={`최고 기록 ${st.best}일`} />
            <Tile label="연속 독서 주" value={`${wk}주`} sub="매주 하루 이상 읽은 주" />
            <Tile
              label="이번 주"
              value={formatMinutes(thisWeek)}
              sub={lastWeek ? `지난주 대비 ${thisWeek >= lastWeek ? "▲" : "▼"} ${formatMinutes(Math.abs(thisWeek - lastWeek))}` : "지난주 기록 없음"}
              tone={lastWeek ? (thisWeek >= lastWeek ? "up" : "down") : undefined}
            />
            <Tile label={`${year}년 완독`} value={`${finishedThisYear}권`} />
            <Tile label="총 독서 시간" value={formatMinutes(totalMs)} sub={`${Object.keys(books).length}권`} />
            <Tile label="읽기 속도" value={speed ? `${Math.round(speed).toLocaleString()}자/분` : "—"} sub={speed ? "텍스트 파일 기준" : "텍스트를 3분 이상 읽으면 계산"} />
          </div>
        </div>

        <Heatmap days={days} goalMin={goalMin} />

        <div className="stats-row two">
          <BarChart
            title="최근 30일"
            sub={`하루 평균 ${formatMinutes((last30.reduce((a, x) => a + x.min, 0) / 30) * 60000)}`}
            values={last30.map((x) => x.min)}
            labels={last30.map((x) => `${x.d.getMonth() + 1}/${x.d.getDate()}`)}
            tipTitles={last30.map((x) => fmtDate(x.d))}
            highlight={29}
            goal={goalMin}
            labelEvery={7}
          />
          <BarChart
            title="시간대별 독서"
            sub={hours.some((h) => h > 0) ? `주로 ${peakHour}시~${peakHour + 1}시에 읽어요 (최근 30일)` : "최근 30일 기록 없음"}
            values={hours}
            labels={hours.map((_, i) => `${i}시`)}
            tipTitles={hours.map((_, i) => `${i}:00 – ${i + 1}:00`)}
            labelEvery={6}
          />
        </div>

        <div className="viz-card">
          <div className="card-head">
            <div>
              <div className="card-title">책별 기록</div>
              <div className="card-sub">최근 읽은 순 · 남은 시간은 내 읽기 속도로 계산한 예상치입니다</div>
            </div>
          </div>
          <table className="book-table">
            <thead>
              <tr>
                <th>제목</th>
                <th>진행률</th>
                <th className="num">읽은 시간</th>
                <th className="num">읽은 날</th>
                <th className="num">남은 예상 시간</th>
                <th className="num">마지막으로 읽음</th>
              </tr>
            </thead>
            <tbody>
              {bookRows.map(({ id, b, pct, readDays, left, entry }) => (
                <tr key={id} className={entry ? "clickable" : ""} onClick={() => entry && onOpen(entry)}>
                  <td className="title-cell">
                    <span>{b.title}</span>
                    {b.finishedAt && <span className="badge done">완독</span>}
                  </td>
                  <td>
                    <div className="pct-cell">
                      <div className="bar">
                        <i style={{ width: `${pct * 100}%` }} />
                      </div>
                      <span>{formatPct(pct)}</span>
                    </div>
                  </td>
                  <td className="num">{formatMinutes(b.ms)}</td>
                  <td className="num">{readDays}일</td>
                  <td className="num">{b.finishedAt || pct >= 0.995 ? "—" : left != null ? `약 ${formatMinutes(left)}` : "계산 중"}</td>
                  <td className="num">{new Date(b.lastRead).toLocaleDateString()}</td>
                </tr>
              ))}
              {bookRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    기록된 책이 없습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
