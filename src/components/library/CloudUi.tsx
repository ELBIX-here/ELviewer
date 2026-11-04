import { useEffect, useState } from "react";
import { useCloud } from "../../store/cloud";
import { listFolder, type DriveItem } from "../../lib/gdrive";
import { formatAgo } from "../../lib/text";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconBack, IconCloud, IconFolder, IconRefresh } from "../Icons";

const iconStyle = { width: 16, height: 16, stroke: "currentColor", fill: "none", strokeWidth: 1.8 } as const;

/** Sidebar block: Google Drive account, sync status and "add Drive folder". */
export function CloudSection({ onAddFolder, openId }: { onAddFolder: () => void; openId?: string | null }) {
  const c = useCloud();
  const [confirmOut, setConfirmOut] = useState(false);
  // Re-render the "n분 전" label now and then.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!c.hydrated) return null;
  if (!c.connected) {
    return (
      <div className="cloud-box">
        <div className="cloud-head">
          <IconCloud style={iconStyle} />
          Google Drive
        </div>
        {c.available ? (
          <div className="cloud-sub">Drive 폴더의 소설을 읽고, 읽은 위치·책갈피·하이라이트를 PC와 휴대폰에서 동기화합니다.</div>
        ) : (
          <div className="cloud-sub">이 빌드에는 Google 로그인 설정이 없습니다.</div>
        )}
        {c.error && <div className="cloud-err">{c.error}</div>}
        {c.connecting ? (
          <button className="btn ghost" onClick={c.cancelConnect}>
            브라우저에서 로그인 중… (취소)
          </button>
        ) : (
          <button className="btn ghost" onClick={() => void c.connect()} disabled={!c.available}>
            Google 계정 연결
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="cloud-box">
      <div className="cloud-head">
        <IconCloud style={iconStyle} />
        <span className="cloud-email" title={c.email ?? ""}>
          {c.email}
        </span>
      </div>
      {c.needsReauth ? (
        <>
          <div className="cloud-warn" role="alert">
            <span>
              <b>로그인이 만료됐어요</b>
              다시 로그인하면 동기화를 이어서 합니다.
            </span>
          </div>
          {c.connecting ? (
            <button className="btn ghost" onClick={c.cancelConnect}>
              로그인 중… (취소)
            </button>
          ) : (
            <button className="btn primary" onClick={() => void c.connect()}>
              다시 로그인
            </button>
          )}
        </>
      ) : (
        <div className="cloud-sub">{c.syncing ? "동기화 중…" : `마지막 동기화: ${formatAgo(c.lastSync)}`}</div>
      )}
      {c.error && <div className="cloud-err">{c.error}</div>}
      <div className="cloud-actions">
        <button className="btn ghost" onClick={() => void c.sync(openId)} disabled={c.syncing} title="지금 동기화">
          <IconRefresh style={iconStyle} />
          동기화
        </button>
        <button className="btn ghost" onClick={onAddFolder}>
          Drive 폴더 추가
        </button>
      </div>
      <button className="btn ghost cloud-out" onClick={() => setConfirmOut(true)}>
        연결 해제
      </button>
      {confirmOut && (
        <ConfirmDialog
          title="Google Drive 연결을 해제할까요?"
          message="Drive 폴더의 책은 서재에서 열 수 없게 되고, 다른 기기와의 동기화도 멈춥니다. 이 기기의 읽기 기록은 그대로 남아요."
          confirmLabel="연결 해제"
          danger
          onCancel={() => setConfirmOut(false)}
          onConfirm={() => {
            setConfirmOut(false);
            void c.disconnect();
          }}
        />
      )}
    </div>
  );
}

interface Crumb {
  id: string;
  name: string;
}

/** Folder browser for picking a Drive folder as a library root. */
export function DrivePicker({ onPick, onClose }: { onPick: (folderId: string, name: string) => void; onClose: () => void }) {
  const [path, setPath] = useState<Crumb[]>([{ id: "root", name: "내 드라이브" }]);
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = path[path.length - 1];

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    listFolder(cur.id, true)
      .then((list) => alive && setItems(list))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cur.id]);

  const top = path.length === 1;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal drive-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Google Drive 폴더 선택</div>
        <div className="drive-tabs">
          <button className={path[0].id === "root" ? "on" : ""} onClick={() => setPath([{ id: "root", name: "내 드라이브" }])}>
            내 드라이브
          </button>
          <button className={path[0].id === "shared" ? "on" : ""} onClick={() => setPath([{ id: "shared", name: "공유 문서함" }])}>
            공유 문서함
          </button>
        </div>
        <div className="drive-crumbs">
          {!top && (
            <button className="icon-btn" onClick={() => setPath(path.slice(0, -1))} title="위로">
              <IconBack />
            </button>
          )}
          <span>{path.map((p) => p.name).join(" › ")}</span>
        </div>
        <div className="drive-list">
          {error && <div className="cloud-err">{error}</div>}
          {!error && !items && (
            <div className="center">
              <div className="spinner" />
            </div>
          )}
          {items?.length === 0 && <div className="muted drive-empty">하위 폴더가 없습니다</div>}
          {items?.map((it) => (
            <div key={it.id} className="drive-row" onClick={() => setPath([...path, { id: it.id, name: it.name }])}>
              <IconFolder style={{ width: 18, height: 18, stroke: "currentColor", fill: "none", strokeWidth: 1.8 }} />
              <span>{it.name}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="muted">{cur.id === "shared" ? "공유받은 폴더를 여세요" : "하위 폴더까지 모두 읽습니다"}</span>
          <button className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={cur.id === "shared"} onClick={() => onPick(cur.id, cur.name)}>
            이 폴더 추가
          </button>
        </div>
      </div>
    </div>
  );
}
