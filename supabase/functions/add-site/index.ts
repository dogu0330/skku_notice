// Supabase Edge Function: add-site
//
// 사용자가 화면에서 "학과 이름 + 공지 게시판 URL"을 제출하면,
// 이 함수가 서버 쪽에서 그 페이지를 대신 가져와(브라우저 CORS 문제 없음) 파싱하고,
// 파싱에 성공한 경우에만 sites / notices 테이블에 저장한다.
//
// 안전장치:
//   1. list_url 은 *.skku.edu 도메인만 허용한다 (임의 URL을 대신 긁어오는 프록시로
//      악용되는 것을 막기 위함 — SSRF/스크레이핑 남용 방지).
//   2. crawler/crawl.py 와 같은 jwxe 게시판 셀렉터로 파싱했을 때 글이 하나도
//      안 나오면 "지원하지 않는 구조"로 보고 저장하지 않는다.
//   3. 같은 클라이언트 IP가 짧은 시간에 너무 여러 번 제출하면 429 로 거절한다.
//
// 배포: Supabase 대시보드 → Edge Functions → New function → 이름 "add-site" →
//       이 파일 내용을 붙여넣고 Deploy. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는
//       Supabase 가 모든 Edge Function 에 자동으로 넣어주는 값이라 따로 설정할 필요 없다.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5분
const RATE_LIMIT_MAX = 5; // 같은 IP에서 5분에 5번까지만

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanText(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function canonicalizeUrl(raw: string) {
  const u = new URL(raw);
  u.searchParams.delete("article.offset");
  u.searchParams.delete("articleLimit");
  return u.toString();
}

async function sha1Hex16(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function isAllowedHost(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "skku.edu" || h.endsWith(".skku.edu");
}

// crawler/crawl.py 의 SELECTOR_PRESETS["jwxe"] 와 동일한 규칙.
async function parseJwxeBoard(html: string, listUrl: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];

  const items: Array<{
    title: string;
    category: string | null;
    published_date: string | null;
    original_url: string;
  }> = [];

  const listItems = doc.querySelectorAll("ul.board-list-wrap > li");
  for (const li of Array.from(listItems)) {
    const el = li as unknown as Element;
    const link = el.querySelector("dt.board-list-content-title a");
    const href = link?.getAttribute("href");
    if (!href) continue;

    const title = cleanText(link?.textContent);
    if (!title) continue;

    let originalUrl: string;
    try {
      originalUrl = canonicalizeUrl(new URL(href, listUrl).toString());
    } catch {
      continue;
    }

    const catEl = el.querySelector("span.c-board-list-category");
    let category: string | null = catEl ? cleanText(catEl.textContent) : null;
    category = category ? category.replace(/^\[|\]$/g, "").trim() : null;
    if (!category) category = null;

    let publishedDate: string | null = null;
    const infoItems = Array.from(el.querySelectorAll("dd.board-list-content-info li"));
    for (const infoEl of infoItems) {
      const m = cleanText((infoEl as unknown as Element).textContent).match(/\d{4}-\d{2}-\d{2}/);
      if (m) {
        publishedDate = m[0];
        break;
      }
    }

    items.push({ title, category, published_date: publishedDate, original_url: originalUrl });
  }

  return items;
}

async function checkRateLimit(admin: ReturnType<typeof createClient>, ip: string) {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count, error } = await admin
    .from("site_submissions")
    .select("id", { count: "exact", head: true })
    .eq("client_ip", ip)
    .gte("created_at", since);
  if (error) return true; // 카운트 조회가 실패해도 제출 자체는 막지 않는다
  return (count ?? 0) < RATE_LIMIT_MAX;
}

async function logSubmission(
  admin: ReturnType<typeof createClient>,
  ip: string,
  name: string,
  listUrl: string,
  ok: boolean,
  message: string
) {
  await admin
    .from("site_submissions")
    .insert({ client_ip: ip, name, list_url: listUrl, ok, message });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "POST만 지원합니다." }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  let body: { name?: string; list_url?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const name = cleanText(body.name).slice(0, 30);
  const rawUrl = cleanText(body.list_url);

  if (!name) return jsonResponse({ ok: false, error: "학과 이름을 입력해 주세요." }, 400);
  if (!rawUrl) return jsonResponse({ ok: false, error: "게시판 URL을 입력해 주세요." }, 400);

  let listUrl: URL;
  try {
    listUrl = new URL(rawUrl);
  } catch {
    return jsonResponse({ ok: false, error: "올바른 URL 형식이 아닙니다." }, 400);
  }
  if (listUrl.protocol !== "https:" && listUrl.protocol !== "http:") {
    return jsonResponse({ ok: false, error: "http(s) 주소만 등록할 수 있습니다." }, 400);
  }
  if (!isAllowedHost(listUrl.hostname)) {
    return jsonResponse(
      { ok: false, error: "성균관대(skku.edu) 사이트만 등록할 수 있습니다." },
      400
    );
  }

  if (!(await checkRateLimit(admin, ip))) {
    return jsonResponse(
      { ok: false, error: "너무 여러 번 시도했습니다. 잠시 후 다시 시도해 주세요." },
      429
    );
  }

  // 사이트 서버가 느리거나 응답이 없을 때 함수가 무한정 매달리지 않도록 타임아웃을 건다.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let html: string;
  try {
    const res = await fetch(listUrl.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SkkuNoticeBot/1.0)" },
      signal: controller.signal,
    });
    if (!res.ok) {
      await logSubmission(admin, ip, name, listUrl.toString(), false, `fetch ${res.status}`);
      return jsonResponse(
        { ok: false, error: `사이트 응답 오류(${res.status})입니다. 주소를 다시 확인해 주세요.` },
        400
      );
    }
    html = await res.text();
  } catch (e) {
    await logSubmission(admin, ip, name, listUrl.toString(), false, String(e));
    return jsonResponse(
      { ok: false, error: "사이트에 접속하지 못했습니다. 주소를 다시 확인해 주세요." },
      400
    );
  } finally {
    clearTimeout(timeout);
  }

  const parsed = await parseJwxeBoard(html, listUrl.toString());
  if (parsed.length === 0) {
    await logSubmission(admin, ip, name, listUrl.toString(), false, "no items parsed");
    return jsonResponse(
      {
        ok: false,
        error:
          "이 페이지에서 공지 게시판 구조를 찾지 못했습니다. 다른 학과 사이트들과 구조가 다른 것 같아요.",
      },
      422
    );
  }

  const { error: siteError } = await admin
    .from("sites")
    .upsert(
      { name, list_url: listUrl.toString(), preset: "jwxe", page_size: 10, is_active: true },
      { onConflict: "list_url" }
    );
  if (siteError) {
    await logSubmission(admin, ip, name, listUrl.toString(), false, siteError.message);
    return jsonResponse({ ok: false, error: "사이트 저장 중 오류가 발생했습니다." }, 500);
  }

  const now = new Date().toISOString();
  const rows = await Promise.all(
    parsed.map(async (item) => ({
      id: await sha1Hex16(item.original_url),
      title: item.title,
      source_site: name,
      category: item.category,
      published_date: item.published_date,
      original_url: item.original_url,
      crawled_at: now,
      first_seen_at: now,
    }))
  );

  // 이미 있던 공지는 first_seen_at 을 덮어쓰지 않도록, 기존 값을 먼저 조회해 둔다.
  const { data: existing } = await admin
    .from("notices")
    .select("id, first_seen_at")
    .in(
      "id",
      rows.map((r) => r.id)
    );
  const firstSeenById = new Map((existing ?? []).map((r) => [r.id, r.first_seen_at]));
  for (const row of rows) {
    const prev = firstSeenById.get(row.id);
    if (prev) row.first_seen_at = prev;
  }

  const { error: noticesError } = await admin.from("notices").upsert(rows, { onConflict: "id" });
  if (noticesError) {
    await logSubmission(admin, ip, name, listUrl.toString(), false, noticesError.message);
    return jsonResponse({ ok: false, error: "공지 저장 중 오류가 발생했습니다." }, 500);
  }

  await logSubmission(admin, ip, name, listUrl.toString(), true, `parsed ${rows.length}`);
  return jsonResponse({ ok: true, name, count: rows.length });
});
