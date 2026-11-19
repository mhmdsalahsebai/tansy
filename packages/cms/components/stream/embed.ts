/**
 * The player address for a YouTube or Vimeo link, or null for anything else. Only an
 * id that matches the host's own format reaches the address, so a link can't steer the
 * frame anywhere else.
 */
export function embedUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  const id = (value: string | null | undefined, pattern: RegExp) => (value && pattern.test(value) ? value : null);
  const youtube = /^[A-Za-z0-9_-]{6,20}$/;
  let video: string | null = null;
  if (host === "youtube.com" || host === "m.youtube.com") video = id(parsed.pathname === "/watch" ? parsed.searchParams.get("v") : parsed.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1], youtube);
  else if (host === "youtu.be") video = id(parsed.pathname.slice(1), youtube);
  if (video) return `https://www.youtube-nocookie.com/embed/${video}`;
  if (host === "vimeo.com") {
    const vimeo = id(parsed.pathname.slice(1), /^\d{1,12}$/);
    if (vimeo) return `https://player.vimeo.com/video/${vimeo}`;
  }
  return null;
}

/** Whether the Content Security Policy lets the dashboard frame this address, so the canvas never shows a blocked frame. */
export function canFrame(src: string, frames: readonly string[] | undefined) {
  if (!frames?.length) return false;
  try {
    return frames.includes(new URL(src).origin);
  } catch {
    return false;
  }
}
