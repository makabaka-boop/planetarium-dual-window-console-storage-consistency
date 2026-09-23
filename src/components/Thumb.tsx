import { useEffect, useState } from 'react';
import { getBlob } from '../db';

/** 从 IndexedDB 读 Blob 并生成临时预览 URL；decodeFailed 的项由调用方自行处理。 */
export function Thumb(props: { blobId: string; alt: string; large?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    getBlob(props.blobId)
      .then((blob) => {
        if (!blob || revoked) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [props.blobId]);

  if (failed) return <span className="decode-failed">读取失败</span>;
  if (!url) return <span className="thumb-loading">…</span>;
  return (
    <img
      src={url}
      alt={props.alt}
      className={props.large ? 'thumb thumb-large' : 'thumb'}
      onError={() => setFailed(true)}
    />
  );
}
