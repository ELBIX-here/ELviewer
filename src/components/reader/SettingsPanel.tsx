import type { ReactNode } from "react";
import { FONT_PRESETS, THEMES, useSettings } from "../../store/settings";
import type { Settings, ThemeName } from "../../types";
import { PanelShell } from "./Panels";
import { isAndroid } from "../../lib/platform";
import { useCloud } from "../../store/cloud";

function Stepper({ value, min, max, step, onChange, fmt }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div className="stepper">
      <button onClick={() => onChange(clamp(value - step))}>−</button>
      <span>{fmt ? fmt(value) : value}</span>
      <button onClick={() => onChange(clamp(value + step))}>+</button>
    </div>
  );
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

export function SettingsPanel({ onClose, extra, scope }: { onClose: () => void; extra?: ReactNode; scope: "text" | "ebook" | "pdf" | "image" }) {
  const { settings: s, set } = useSettings();
  const cloudConnected = useCloud((c) => c.connected);
  const isText = scope === "text";
  const hasTypography = scope === "text" || scope === "ebook";
  const presetMatch = FONT_PRESETS.find((f) => f.value === s.fontFamily);

  return (
    <PanelShell title="설정" onClose={onClose}>
      <div className="panel-body form">
        <div className="group">테마</div>
        <div className="swatches">
          {(Object.keys(THEMES) as Exclude<ThemeName, "custom">[]).map((k) => (
            <button
              key={k}
              className={`swatch ${s.theme === k ? "on" : ""}`}
              title={THEMES[k].label}
              style={{ background: THEMES[k].bg, color: THEMES[k].fg }}
              onClick={() => set({ theme: k })}
            >
              가
            </button>
          ))}
          <button
            className={`swatch ${s.theme === "custom" ? "on" : ""}`}
            title="사용자 지정"
            style={{ background: s.customBg, color: s.customFg }}
            onClick={() => set({ theme: "custom" })}
          >
            가
          </button>
        </div>
        {s.theme === "custom" && (
          <div className="field">
            <label>사용자 색</label>
            <div className="ctl">
              <span className="muted" style={{ fontSize: 12 }}>
                배경
              </span>
              <input type="color" value={s.customBg} onChange={(e) => set({ customBg: e.target.value })} />
              <span className="muted" style={{ fontSize: 12 }}>
                글자
              </span>
              <input type="color" value={s.customFg} onChange={(e) => set({ customFg: e.target.value })} />
            </div>
          </div>
        )}

        {isText && (
          <>
            <div className="group">읽기 방식</div>
            <div className="field">
              <label>모드</label>
              <div className="ctl">
                <Seg
                  value={s.readMode}
                  options={[
                    { v: "scroll", l: "스크롤" },
                    { v: "page", l: "페이지" },
                  ]}
                  onChange={(v) => set({ readMode: v })}
                />
              </div>
            </div>
            {s.readMode === "page" && (
              <>
                <div className="field">
                  <label>단 수</label>
                  <div className="ctl">
                    <Seg
                      value={s.columns}
                      options={[
                        { v: 1, l: "1쪽" },
                        { v: 2, l: "2쪽 펼침" },
                        { v: 0, l: "자동" },
                      ]}
                      onChange={(v) => set({ columns: v as 0 | 1 | 2 })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>넘김 효과</label>
                  <div className="ctl">
                    <Seg
                      value={s.animation}
                      options={[
                        { v: "none", l: "없음" },
                        { v: "slide", l: "슬라이드" },
                        { v: "fade", l: "페이드" },
                      ]}
                      onChange={(v) => set({ animation: v })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>자동 넘김</label>
                  <div className="ctl">
                    <Stepper value={s.autoPageSec} min={3} max={120} step={1} onChange={(v) => set({ autoPageSec: v })} fmt={(v) => `${v}초`} />
                  </div>
                </div>
              </>
            )}
            {s.readMode === "scroll" && (
              <div className="field">
                <label>자동 스크롤</label>
                <div className="ctl">
                  <Stepper value={s.autoScrollSpeed} min={5} max={400} step={5} onChange={(v) => set({ autoScrollSpeed: v })} fmt={(v) => `${v}px/s`} />
                </div>
              </div>
            )}
            <div className="field">
              <label>빈 줄 정리</label>
              <div className="ctl">
                <Seg
                  value={s.collapseBlank ? 1 : 0}
                  options={[
                    { v: 1, l: "켬" },
                    { v: 0, l: "끔" },
                  ]}
                  onChange={(v) => set({ collapseBlank: v === 1 })}
                />
              </div>
            </div>
          </>
        )}

        {scope === "ebook" && (
          <>
            <div className="group">읽기 방식</div>
            <div className="field">
              <label>모드</label>
              <div className="ctl">
                <Seg
                  value={s.readMode}
                  options={[
                    { v: "scroll", l: "스크롤" },
                    { v: "page", l: "페이지" },
                  ]}
                  onChange={(v) => set({ readMode: v })}
                />
              </div>
            </div>
            <div className="field">
              <label>단 수</label>
              <div className="ctl">
                <Seg
                  value={s.columns}
                  options={[
                    { v: 1, l: "1쪽" },
                    { v: 2, l: "2쪽 펼침" },
                        { v: 0, l: "자동" },
                  ]}
                  onChange={(v) => set({ columns: v as 0 | 1 | 2 })}
                />
              </div>
            </div>
          </>
        )}

        {(scope === "pdf" || scope === "image") && (
          <>
            <div className="group">읽기 방식</div>
            <div className="field">
              <label>모드</label>
              <div className="ctl">
                <Seg
                  value={s.readMode}
                  options={[
                    { v: "scroll", l: "세로 스크롤" },
                    { v: "page", l: "한 장씩" },
                  ]}
                  onChange={(v) => set({ readMode: v })}
                />
              </div>
            </div>
          </>
        )}

        {hasTypography && (
          <>
            <div className="group">글꼴</div>
            <div className="field">
              <label>글꼴</label>
              <div className="ctl">
                <select
                  value={presetMatch ? s.fontFamily : "__custom"}
                  onChange={(e) => {
                    if (e.target.value !== "__custom") set({ fontFamily: e.target.value });
                  }}
                >
                  {FONT_PRESETS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                  <option value="__custom">직접 입력…</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>직접 입력</label>
              <div className="ctl">
                <input type="text" value={s.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} placeholder="예: Noto Serif KR" />
              </div>
            </div>
            <div className="field">
              <label>크기</label>
              <div className="ctl">
                <Stepper value={s.fontSize} min={10} max={48} step={1} onChange={(v) => set({ fontSize: v })} fmt={(v) => `${v}px`} />
              </div>
            </div>
            <div className="field">
              <label>줄 간격</label>
              <div className="ctl">
                <Stepper value={s.lineHeight} min={1.1} max={3} step={0.1} onChange={(v) => set({ lineHeight: +v.toFixed(1) })} fmt={(v) => v.toFixed(1)} />
              </div>
            </div>
            <div className="field">
              <label>자간</label>
              <div className="ctl">
                <Stepper value={s.letterSpacing} min={-1} max={3} step={0.1} onChange={(v) => set({ letterSpacing: +v.toFixed(1) })} fmt={(v) => `${v.toFixed(1)}px`} />
              </div>
            </div>
            <div className="field">
              <label>문단 간격</label>
              <div className="ctl">
                <Stepper value={s.paragraphSpacing} min={0} max={3} step={0.1} onChange={(v) => set({ paragraphSpacing: +v.toFixed(1) })} fmt={(v) => `${v.toFixed(1)}em`} />
              </div>
            </div>
            {isText && (
              <div className="field">
                <label>들여쓰기</label>
                <div className="ctl">
                  <Stepper value={s.textIndent} min={0} max={4} step={0.5} onChange={(v) => set({ textIndent: v })} fmt={(v) => `${v}em`} />
                </div>
              </div>
            )}
            <div className="field">
              <label>정렬</label>
              <div className="ctl">
                <Seg
                  value={s.textAlign}
                  options={[
                    { v: "left", l: "왼쪽" },
                    { v: "justify", l: "양쪽" },
                  ]}
                  onChange={(v) => set({ textAlign: v as Settings["textAlign"] })}
                />
              </div>
            </div>

            <div className="group">여백</div>
            <div className="field">
              <label>본문 최대 폭</label>
              <div className="ctl">
                <Stepper value={s.maxWidth} min={400} max={2400} step={20} onChange={(v) => set({ maxWidth: v })} fmt={(v) => `${v}px`} />
              </div>
            </div>
            <div className="field">
              <label>좌우 여백</label>
              <div className="ctl">
                <Stepper value={s.padding} min={0} max={240} step={4} onChange={(v) => set({ padding: v })} fmt={(v) => `${v}px`} />
              </div>
            </div>
          </>
        )}

        <div className="group">화면</div>
        <div className="field">
          <label>메뉴 자동 숨김</label>
          <div className="ctl">
            <Seg
              value={s.uiAutoHideSec}
              options={[
                { v: 0, l: "클릭할 때만" },
                { v: 3, l: "3초" },
                { v: 6, l: "6초" },
              ]}
              onChange={(v) => set({ uiAutoHideSec: v })}
            />
          </div>
        </div>
        <div className="field">
          <label>숨김 중 진행률</label>
          <div className="ctl">
            <Seg
              value={s.showMiniProgress ? 1 : 0}
              options={[
                { v: 1, l: "표시" },
                { v: 0, l: "숨김" },
              ]}
              onChange={(v) => set({ showMiniProgress: v === 1 })}
            />
          </div>
        </div>
        {cloudConnected && (
          <div className="field">
            <label>다른 기기 기록</label>
            <div className="ctl">
              <Seg
                value={s.syncOpen}
                options={[
                  { v: "ask", l: "열 때 묻기" },
                  { v: "latest", l: "최근 기록으로" },
                ]}
                onChange={(v) => set({ syncOpen: v })}
              />
            </div>
          </div>
        )}
        {isAndroid() && (
          <div className="field">
            <label>볼륨 키 넘김</label>
            <div className="ctl">
              <Seg
                value={s.volumeKeyPaging ? 1 : 0}
                options={[
                  { v: 1, l: "켬" },
                  { v: 0, l: "끔" },
                ]}
                onChange={(v) => set({ volumeKeyPaging: v === 1 })}
              />
            </div>
          </div>
        )}

        {extra}

        <div className="group">단축키</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          <div>
            <kbd>←</kbd> <kbd>→</kbd> <kbd>Space</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> 페이지 이동
          </div>
          <div>
            <kbd>Home</kbd> <kbd>End</kbd> 처음 / 끝 · <kbd>Ctrl</kbd>+<kbd>←</kbd>/<kbd>→</kbd> 이전 / 다음 파일
          </div>
          <div>
            <kbd>M</kbd> 모드 전환 · <kbd>T</kbd> 목차 · <kbd>B</kbd> 책갈피 · <kbd>A</kbd> 자동 스크롤/넘김
          </div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>F</kbd> 검색 · <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>−</kbd> 글자 크기 · <kbd>F11</kbd> 전체 화면
          </div>
          <div>
            <kbd>Esc</kbd> 패널 닫기 / 서재로 · 화면 가운데 클릭 또는 <kbd>Enter</kbd>: 메뉴 표시/숨김
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
