import { createContext, useContext, useEffect, useState } from "react";
import type { ImageLoader, RichBlock } from "../../lib/rich";

/** How the views find the pictures of the open document. */
export const ImageLoaderContext = createContext<ImageLoader | null>(null);

/** A picture or table drawn in place of its paragraph. */
export function RichBlockView({ block }: { block: RichBlock }) {
  if (block.kind === "img") return <Picture src={block.src} alt={block.alt} />;
  return (
    <div className="rich-table-wrap">
      <table className="rich-table">
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>
              {r.cells.map((c, j) => (r.head[j] ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Picture({ src, alt }: { src: string; alt: string }) {
  const loader = useContext(ImageLoaderContext);
  // undefined: loading, null: not found or broken
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    if (!loader) return;
    void loader.load(src).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [loader, src]);

  if (url === null) return <div className="rich-missing">{alt ? `그림: ${alt}` : "그림"} · 찾을 수 없음</div>;
  return (
    <figure className={`rich-fig ${url ? "" : "loading"}`}>
      {url && <img src={url} alt={alt} decoding="async" draggable={false} onError={() => setUrl(null)} />}
      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  );
}
