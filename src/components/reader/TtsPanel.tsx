import { useSettings } from "../../store/settings";
import { VOICE_LABELS, type TtsStatus } from "../../lib/tts";
import { PanelShell } from "./Panels";
import { IconPause, IconPlay, IconSkipBack, IconSkipForward, IconStop } from "../Icons";

export interface TtsPanelProps {
  status: TtsStatus | null;
  state: "playing" | "paused" | "stopped" | "loading";
  currentText: string | null;
  error: string | null;
  download: { done: number; total: number } | null;
  sleepChoice: number | null;
  sleepLeftMin: number | null;
  onClose: () => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPrevSentence: () => void;
  onNextSentence: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onDeleteModel: () => void;
  /** Android: open the phone's text-to-speech settings */
  onOpenSystemSettings?: () => void;
  onSleep: (min: number | null) => void;
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

const mb = (b: number) => `${Math.round(b / 1e6)}MB`;

export function TtsPanel(p: TtsPanelProps) {
  const { settings: s, set } = useSettings();
  const playing = p.state === "playing" || p.state === "loading";
  const system = p.status?.engine === "system";

  if (!p.status) {
    return (
      <PanelShell title="읽어 주기" onClose={p.onClose}>
        <div className="center" style={{ height: 160 }}>
          <div className="spinner" />
        </div>
      </PanelShell>
    );
  }

  if (system && !p.status.installed) {
    return (
      <PanelShell title="읽어 주기" onClose={p.onClose}>
        <div className="panel-body form" style={{ lineHeight: 1.6, fontSize: 13 }}>
          <p style={{ marginTop: 8 }}>이 기기의 음성 엔진(TTS)을 시작하지 못했습니다.</p>
          <p className="muted">설정 → 일반 → 텍스트 음성 변환에서 기본 엔진을 고르고 한국어 음성 데이터를 설치한 뒤 다시 열어 주세요.</p>
          <button className="btn primary" style={{ marginTop: 12, width: "100%" }} onClick={p.onOpenSystemSettings}>
            음성 설정 열기
          </button>
          {p.error && <p style={{ color: "var(--danger)", fontSize: 12 }}>{p.error}</p>}
        </div>
      </PanelShell>
    );
  }

  if (!p.status.installed) {
    const pct = p.download ? p.download.done / p.download.total : 0;
    return (
      <PanelShell title="읽어 주기" onClose={p.onClose}>
        <div className="panel-body form" style={{ lineHeight: 1.6, fontSize: 13 }}>
          <p style={{ marginTop: 8 }}>
            ELviewer는 인터넷이나 운영체제 음성 없이 PC에서 직접 문장을 읽어 주는 <b>Supertonic 3</b> 음성 모델(슈퍼톤)을 사용합니다.
          </p>
          <p className="muted">
            음성 10종(여성 5 · 남성 5), 44.1kHz. 처음 한 번 <b>{mb(p.status.downloadBytes)}</b>를 받으면 이후에는 오프라인으로 동작합니다. 설치 파일로 설치했다면 모델이 이미
            포함되어 있습니다.
          </p>
          {p.download ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              <div className="bar" style={{ width: "100%", height: 6 }}>
                <i style={{ width: `${pct * 100}%` }} />
              </div>
              <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span>
                  {mb(p.download.done)} / {mb(p.download.total)}
                </span>
                <span>{Math.floor(pct * 100)}%</span>
              </div>
              <button className="btn" onClick={p.onCancelDownload}>
                취소
              </button>
            </div>
          ) : (
            <button className="btn primary" style={{ marginTop: 12, width: "100%", justifyContent: "center" }} onClick={p.onDownload}>
              음성 모델 받기 ({mb(p.status.downloadBytes)})
            </button>
          )}
          {p.error && <p style={{ color: "var(--danger)", fontSize: 12 }}>{p.error}</p>}
          <p className="muted" style={{ fontSize: 11, marginTop: 18 }}>
            모델 라이선스: BigScience OpenRAIL-M. 법령 위반, 타인 사칭, 미성년자 대상 악용 등 라이선스 부속서 A의 금지 용도로 사용할 수 없습니다.
          </p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="읽어 주기" onClose={p.onClose}>
      <div className="panel-body form">
        <div className="tts-now">{p.currentText ?? (p.state === "stopped" ? "현재 화면 위치부터 읽습니다" : "준비 중…")}</div>
        <div className="tts-controls">
          <button className="icon-btn" title="이전 문장" onClick={p.onPrevSentence} disabled={p.state === "stopped"}>
            <IconSkipBack />
          </button>
          <button className="icon-btn big" title={playing ? "일시 정지" : "재생"} onClick={playing ? p.onPause : p.onPlay}>
            {p.state === "loading" ? <div className="spinner small" /> : playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="icon-btn" title="다음 문장" onClick={p.onNextSentence} disabled={p.state === "stopped"}>
            <IconSkipForward />
          </button>
          <button className="icon-btn" title="정지" onClick={p.onStop} disabled={p.state === "stopped"}>
            <IconStop />
          </button>
        </div>
        {p.error && <div style={{ color: "var(--danger)", fontSize: 12, padding: "4px 0" }}>{p.error}</div>}

        <div className="group">음성</div>
        {system ? (
          <>
            {p.status.korean === false && (
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 6 }}>
                한국어 음성 데이터가 없어 다른 언어로 읽힐 수 있습니다. 음성 설정에서 한국어 데이터를 설치해 주세요.
              </div>
            )}
            <div className="voice-grid">
              {["", ...p.status.voices].map((v) => (
                <button key={v || "default"} className={`voice ${s.ttsSystemVoice === v ? "on" : ""}`} onClick={() => set({ ttsSystemVoice: v })}>
                  {v ? (p.status!.labels?.[v] ?? v) : "기본"}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="voice-grid">
            {p.status.voices.map((v) => (
              <button key={v} className={`voice ${s.ttsVoice === v ? "on" : ""}`} onClick={() => set({ ttsVoice: v })}>
                {VOICE_LABELS[v] ?? v}
              </button>
            ))}
          </div>
        )}

        <div className="field">
          <label>속도</label>
          <div className="ctl">
            <input type="range" min={0.7} max={1.8} step={0.05} value={s.ttsSpeed} onChange={(e) => set({ ttsSpeed: Number(e.target.value) })} />
            <span className="val">{s.ttsSpeed.toFixed(2)}×</span>
          </div>
        </div>
        {system ? (
          <div className="field">
            <label>음 높이</label>
            <div className="ctl">
              <input type="range" min={0.7} max={1.4} step={0.05} value={s.ttsPitch} onChange={(e) => set({ ttsPitch: Number(e.target.value) })} />
              <span className="val">{s.ttsPitch.toFixed(2)}</span>
            </div>
          </div>
        ) : (
          <div className="field">
            <label>음질</label>
            <div className="ctl">
              <Seg
                value={s.ttsSteps}
                options={[
                  { v: 5, l: "빠름" },
                  { v: 8, l: "표준" },
                  { v: 12, l: "고품질" },
                ]}
                onChange={(v) => set({ ttsSteps: v })}
              />
            </div>
          </div>
        )}
        <div className="field">
          <label>문장 간격</label>
          <div className="ctl">
            <Seg
              value={s.ttsGap}
              options={[
                { v: 0.1, l: "짧게" },
                { v: 0.25, l: "보통" },
                { v: 0.5, l: "길게" },
              ]}
              onChange={(v) => set({ ttsGap: v })}
            />
          </div>
        </div>
        <div className="field">
          <label>볼륨</label>
          <div className="ctl">
            <input
              type="range"
              min={0}
              max={system ? 1 : 1.5}
              step={0.05}
              value={Math.min(s.ttsVolume, system ? 1 : 1.5)}
              onChange={(e) => set({ ttsVolume: Number(e.target.value) })}
            />
            <span className="val">{Math.round(s.ttsVolume * 100)}%</span>
          </div>
        </div>
        <div className="field">
          <label>화면 따라가기</label>
          <div className="ctl">
            <Seg
              value={s.ttsFollow ? 1 : 0}
              options={[
                { v: 1, l: "켬" },
                { v: 0, l: "끔" },
              ]}
              onChange={(v) => set({ ttsFollow: v === 1 })}
            />
          </div>
        </div>
        <div className="field">
          <label>수면 타이머</label>
          <div className="ctl">
            <Seg value={p.sleepChoice ?? 0} options={[{ v: 0, l: "끔" }, ...[15, 30, 60].map((m) => ({ v: m, l: `${m}분` }))]} onChange={(v) => p.onSleep(v === 0 ? null : v)} />
          </div>
        </div>
        {p.sleepLeftMin != null && (
          <div className="muted" style={{ fontSize: 12 }}>
            {p.sleepLeftMin}분 뒤에 멈춥니다
          </div>
        )}

        {system ? (
          <>
            <div className="group">음성 엔진</div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              이 기기의 텍스트 음성 변환 엔진을 사용합니다. 음성 종류와 품질은 엔진에 따라 다릅니다.
            </div>
            <button className="btn ghost" style={{ marginTop: 6 }} onClick={p.onOpenSystemSettings}>
              음성 설정 열기
            </button>
          </>
        ) : (
          <>
            <div className="group">모델</div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              Supertonic 3 (Supertone) · OpenRAIL-M
              <br />
              {p.status.bundled ? "설치 파일에 포함된 모델 사용 중" : "내려받은 모델 사용 중"}
            </div>
            {!p.status.bundled && (
              <button className="btn ghost" style={{ marginTop: 6 }} onClick={p.onDeleteModel}>
                내려받은 모델 삭제
              </button>
            )}
            <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
              <kbd>R</kbd> 재생/일시 정지 · 문장을 드래그한 뒤 "여기서부터 읽기"로 시작 위치 지정
            </div>
          </>
        )}
      </div>
    </PanelShell>
  );
}
