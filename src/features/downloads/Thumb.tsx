import { useEffect, useRef, useState } from "react";
import { thumbnail } from "./thumbnails";

/** A small picture of an image, fetched when the row scrolls into view; nothing shows without one. */
export function Thumb({
  url,
  pageUrl,
  onLoaded,
}: {
  url: string;
  pageUrl: string;
  onLoaded?: (dataUri: string | null) => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [picture, setPicture] = useState<string | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void thumbnail(url, pageUrl).then((result) => {
        if (cancelled) return;
        setPicture(result);
        onLoaded?.(result);
      });
    });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [url, pageUrl, onLoaded]);

  return (
    <span
      ref={box}
      className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-paper/[0.06]"
    >
      {picture && <img src={picture} alt="" className="size-full object-cover" />}
    </span>
  );
}
