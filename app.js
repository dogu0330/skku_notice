/* 성대 공지 모아보기 - 프론트엔드 로직 (프레임워크 없음) */

const STORAGE_KEYS = {
  hiddenCategories: "skku-notices:hidden-categories",
  hiddenSites: "skku-notices:hidden-sites",
  customCategories: "skku-notices:custom-categories",
};

const ALL = "전체";

const state = {
  notices: [],
  sites: [], // 데이터에서 자동으로 뽑는다 (sites.json 에 사이트를 추가하면 여기에도 자동 반영)
  categories: [],
  hiddenCategories: new Set(),
  hiddenSites: new Set(),
  customCategories: [], // [{ id, name, keywords: [] }]
  site: ALL,
  category: ALL,
  customId: null,
  keyword: "",
};

/* ---------- 측정 (Google Analytics) ----------
   index.html 의 gtag 태그는 방문자 수·체류시간·스크롤 같은 기본 지표만 자동으로 잡는다.
   필터 버튼 클릭처럼 화면 안에서만 일어나는 행동은 여기서 직접 보내야 기록된다.
   이벤트 이름은 기획서(PRD) 8장 설계를 따른다.

   주의: 아래 파라미터(filter_type 등)는 GA4 관리자 화면에서 '맞춤 측정기준'으로
   등록해야 보고서에서 값별로 쪼개 볼 수 있다. 등록 전에는 이벤트 발생 횟수만 보인다. */
function track(eventName, params) {
  // 광고 차단기 등으로 gtag 가 로드되지 않은 경우에도 화면 동작은 그대로 유지한다
  if (typeof window.gtag !== "function") return;
  window.gtag("event", eventName, params || {});
}

function trackFilter(filterType, filterValue) {
  track("filter_apply", { filter_type: filterType, filter_value: filterValue });
}

const $ = (id) => document.getElementById(id);
const $list = $("notice-list");
const $empty = $("empty");
const $count = $("count");
const $updated = $("updated");
const $keyword = $("keyword");

/* ---------- 저장소 ---------- */

function loadStorage() {
  try {
    const hidden = JSON.parse(localStorage.getItem(STORAGE_KEYS.hiddenCategories) || "[]");
    if (Array.isArray(hidden)) state.hiddenCategories = new Set(hidden);
    const hiddenSites = JSON.parse(localStorage.getItem(STORAGE_KEYS.hiddenSites) || "[]");
    if (Array.isArray(hiddenSites)) state.hiddenSites = new Set(hiddenSites);
    const custom = JSON.parse(localStorage.getItem(STORAGE_KEYS.customCategories) || "[]");
    if (Array.isArray(custom)) {
      state.customCategories = custom.filter(
        (c) => c && c.id && c.name && Array.isArray(c.keywords)
      );
    }
  } catch (e) {
    /* 저장된 설정이 깨졌으면 기본값으로 시작한다 */
  }
}

function saveStorage() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.hiddenCategories,
      JSON.stringify([...state.hiddenCategories])
    );
    localStorage.setItem(STORAGE_KEYS.hiddenSites, JSON.stringify([...state.hiddenSites]));
    localStorage.setItem(
      STORAGE_KEYS.customCategories,
      JSON.stringify(state.customCategories)
    );
  } catch (e) {
    /* 시크릿 모드 등 저장이 막힌 환경에서는 이번 세션에만 적용된다 */
  }
}

/* ---------- 데이터 ---------- */

/* 데이터 소스 우선순위:
   1) Supabase (config.js 에 설정돼 있으면 여기서 최신 데이터를 읽는다)
   2) data/notices.json (서버로 서빙 중이면 fetch)
   3) data/notices.js 에 담긴 window.NOTICES (file:// 로 열었을 때의 최후 수단) */
async function loadFromSupabase() {
  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  if (!window.supabase || !window.supabase.createClient) return null;

  try {
    const client = window.supabase.createClient(cfg.url, cfg.anonKey);
    const { data, error } = await client
      .from("notices")
      .select("*")
      .order("published_date", { ascending: false });
    if (error) throw error;
    if (Array.isArray(data)) return data;
  } catch (e) {
    console.warn("Supabase 조회 실패, 로컬 데이터로 대체합니다.", e);
  }
  return null;
}

async function loadNotices() {
  const fromSupabase = await loadFromSupabase();
  if (fromSupabase) return fromSupabase;

  const embedded = Array.isArray(window.NOTICES) ? window.NOTICES : [];
  try {
    const res = await fetch("data/notices.json", { cache: "no-store" });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json)) return json;
    }
  } catch (e) {
    /* file:// 환경에서는 fetch 가 막히므로 임베드 데이터를 그대로 사용 */
  }
  return embedded;
}

function collectFacets() {
  const sites = [];
  const categories = [];
  state.notices.forEach((n) => {
    if (n.source_site && !sites.includes(n.source_site)) sites.push(n.source_site);
    if (n.category && !categories.includes(n.category)) categories.push(n.category);
  });
  state.sites = sites;
  state.categories = categories.sort((a, b) => a.localeCompare(b, "ko"));
}

function matchesCustom(notice, custom) {
  const title = (notice.title || "").toLowerCase();
  return custom.keywords.some((kw) => kw && title.includes(kw.toLowerCase()));
}

function visibleNotices() {
  // 숨긴 카테고리 · 숨긴 출처는 목록 자체에서 제외한다
  return state.notices.filter(
    (n) =>
      !(n.category && state.hiddenCategories.has(n.category)) &&
      !state.hiddenSites.has(n.source_site)
  );
}

function filtered() {
  const kw = state.keyword.trim().toLowerCase();
  const custom = state.customCategories.find((c) => c.id === state.customId);
  return visibleNotices()
    .filter((n) => state.site === ALL || n.source_site === state.site)
    .filter((n) => state.category === ALL || n.category === state.category)
    .filter((n) => !custom || matchesCustom(n, custom))
    .filter((n) => !kw || (n.title || "").toLowerCase().includes(kw))
    .sort((a, b) => (b.published_date || "").localeCompare(a.published_date || ""));
}

/* ---------- 렌더링 ---------- */

function makeChip(label, active, onClick, onRemove) {
  const chip = document.createElement("span");
  chip.className = "chip" + (active ? " active" : "");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip-label";
  btn.textContent = label;
  btn.setAttribute("aria-pressed", String(active));
  btn.addEventListener("click", onClick);
  chip.appendChild(btn);

  if (onRemove) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chip-remove";
    del.textContent = "×";
    del.title = label + " 삭제";
    del.setAttribute("aria-label", label + " 카테고리 삭제");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove();
    });
    chip.appendChild(del);
  }
  return chip;
}

function renderSiteFilter() {
  const box = $("site-filter");
  box.innerHTML = "";
  const shown = state.sites.filter((s) => !state.hiddenSites.has(s));
  // 숨긴 출처가 선택된 상태로 남지 않도록 정리
  if (state.site !== ALL && !shown.includes(state.site)) state.site = ALL;

  [ALL, ...shown].forEach((name) => {
    box.appendChild(
      makeChip(name, state.site === name, () => {
        state.site = name;
        trackFilter("site", name);
        renderSiteFilter();
        renderList();
      })
    );
  });
}

function renderSiteChecks() {
  const box = $("site-checks");
  box.innerHTML = "";
  if (state.sites.length === 0) {
    box.textContent = "수집된 출처가 없습니다.";
    return;
  }
  state.sites.forEach((name) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !state.hiddenSites.has(name);
    input.addEventListener("change", () => {
      if (input.checked) state.hiddenSites.delete(name);
      else state.hiddenSites.add(name);
      saveStorage();
      renderSiteFilter();
      renderList();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(name));
    box.appendChild(label);
  });
}

function renderCategoryFilter() {
  const box = $("category-filter");
  box.innerHTML = "";
  const shown = state.categories.filter((c) => !state.hiddenCategories.has(c));
  // 숨긴 카테고리가 선택된 상태로 남지 않도록 정리
  if (state.category !== ALL && !shown.includes(state.category)) state.category = ALL;

  [ALL, ...shown].forEach((name) => {
    box.appendChild(
      makeChip(name, state.category === name, () => {
        state.category = name;
        trackFilter("category", name);
        renderCategoryFilter();
        renderList();
      })
    );
  });
}

function renderCategoryChecks() {
  const box = $("category-checks");
  box.innerHTML = "";
  if (state.categories.length === 0) {
    box.textContent = "수집된 카테고리가 없습니다.";
    return;
  }
  state.categories.forEach((name) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !state.hiddenCategories.has(name);
    input.addEventListener("change", () => {
      if (input.checked) state.hiddenCategories.delete(name);
      else state.hiddenCategories.add(name);
      saveStorage();
      renderCategoryFilter();
      renderList();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(name));
    box.appendChild(label);
  });
}

function renderCustomFilter() {
  const box = $("custom-filter");
  box.innerHTML = "";
  box.appendChild(
    makeChip(ALL, state.customId === null, () => {
      state.customId = null;
      trackFilter("custom", ALL);
      renderCustomFilter();
      renderList();
    })
  );

  if (state.customCategories.length === 0) {
    const hint = document.createElement("span");
    hint.className = "inline-hint";
    hint.textContent = "관심 주제를 키워드로 묶어보세요";
    box.appendChild(hint);
    return;
  }

  state.customCategories.forEach((custom) => {
    const active = state.customId === custom.id;
    const chip = makeChip(
      custom.name,
      active,
      () => {
        state.customId = active ? null : custom.id;
        trackFilter("custom", active ? ALL : custom.name);
        renderCustomFilter();
        renderList();
      },
      () => {
        if (!confirm(custom.name + " 카테고리를 삭제할까요?")) return;
        state.customCategories = state.customCategories.filter((c) => c.id !== custom.id);
        if (state.customId === custom.id) state.customId = null;
        saveStorage();
        renderCustomFilter();
        renderList();
      }
    );
    chip.title = "키워드: " + custom.keywords.join(", ");
    box.appendChild(chip);
  });
}

function renderList() {
  const items = filtered();
  $list.innerHTML = "";
  $empty.hidden = items.length > 0;

  const hiddenCount = state.notices.length - visibleNotices().length;
  $count.textContent =
    "공지 " + items.length + "건" + (hiddenCount > 0 ? " (숨김 " + hiddenCount + "건 제외)" : "");

  const frag = document.createDocumentFragment();
  items.forEach((n) => {
    const li = document.createElement("li");
    li.className = "notice-item";

    const a = document.createElement("a");
    a.href = n.original_url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const title = document.createElement("p");
    title.className = "notice-title";
    title.textContent = n.title;

    const meta = document.createElement("div");
    meta.className = "notice-meta";

    const site = document.createElement("span");
    site.className = "badge";
    site.textContent = n.source_site;
    meta.appendChild(site);

    if (n.category) {
      const cat = document.createElement("span");
      cat.className = "badge cat";
      cat.textContent = n.category;
      meta.appendChild(cat);
    }

    const date = document.createElement("span");
    date.textContent = n.published_date || "";
    meta.appendChild(date);

    // 공지 클릭은 외부 링크라 GA4 가 자동으로도 잡지만, 자동 기록에는 주소만 남아
    // 어느 출처·카테고리의 공지였는지 알 수 없다. 그래서 따로 보낸다.
    a.addEventListener("click", () => {
      track("notice_click", {
        source_site: n.source_site || "(없음)",
        notice_category: n.category || "(없음)",
      });
    });

    a.appendChild(title);
    a.appendChild(meta);
    li.appendChild(a);
    frag.appendChild(li);
  });
  $list.appendChild(frag);
}

function renderUpdated() {
  const latest = state.notices
    .map((n) => n.crawled_at)
    .filter(Boolean)
    .sort()
    .pop();
  if (!latest) return;
  const d = new Date(latest);
  if (isNaN(d)) return;
  const pad = (v) => String(v).padStart(2, "0");
  $updated.textContent =
    "최종 수집 " +
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes());
}

function renderAll() {
  renderSiteFilter();
  renderSiteChecks();
  renderCategoryFilter();
  renderCategoryChecks();
  renderCustomFilter();
  renderList();
}

/* ---------- 이벤트 ---------- */

function togglePanel(buttonId, panelId) {
  const btn = $(buttonId);
  const panel = $(panelId);
  btn.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
}

togglePanel("manage-sites", "site-panel");
togglePanel("manage-categories", "category-panel");
togglePanel("add-custom", "custom-panel");
togglePanel("add-site-btn", "add-site-panel");

$("custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("custom-name").value.trim();
  const keywords = $("custom-keywords")
    .value.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const hint = $("custom-hint");

  if (!name || keywords.length === 0) {
    hint.textContent = "이름과 키워드를 모두 입력해 주세요.";
    return;
  }
  if (state.customCategories.some((c) => c.name === name)) {
    hint.textContent = "'" + name + "' 은 이미 있습니다.";
    return;
  }

  const custom = { id: "c" + Date.now(), name: name, keywords: keywords };
  state.customCategories.push(custom);
  state.customId = custom.id;
  saveStorage();

  $("custom-name").value = "";
  $("custom-keywords").value = "";
  const matched = visibleNotices().filter((n) => matchesCustom(n, custom)).length;
  hint.textContent =
    "'" + name + "' 카테고리를 만들었습니다. 현재 " + matched + "건이 묶였습니다.";

  renderCustomFilter();
  renderList();
});

$("add-site-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("site-name").value.trim();
  const listUrl = $("site-url").value.trim();
  const hint = $("add-site-hint");
  const submitBtn = e.target.querySelector("button[type=submit]");

  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey) {
    hint.textContent = "Supabase 연결이 설정되지 않아 사이트 추가를 사용할 수 없습니다.";
    return;
  }
  if (!name || !listUrl) {
    hint.textContent = "학과 이름과 URL을 모두 입력해 주세요.";
    return;
  }

  submitBtn.disabled = true;
  hint.textContent = "사이트를 확인하는 중입니다...";

  try {
    const res = await fetch(cfg.url + "/functions/v1/add-site", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.anonKey,
        Authorization: "Bearer " + cfg.anonKey,
      },
      body: JSON.stringify({ name, list_url: listUrl }),
    });
    const result = await res.json();

    if (!res.ok || !result.ok) {
      hint.textContent = result.error || "사이트를 추가하지 못했습니다.";
      return;
    }

    hint.textContent =
      "'" + result.name + "' 공지 " + result.count + "건을 추가했습니다!";
    $("site-name").value = "";
    $("site-url").value = "";

    state.notices = await loadNotices();
    collectFacets();
    renderAll();
  } catch (err) {
    hint.textContent = "요청 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  } finally {
    submitBtn.disabled = false;
  }
});

let debounce;
let searchTrackTimer;
$keyword.addEventListener("input", (e) => {
  clearTimeout(debounce);
  const value = e.target.value;
  debounce = setTimeout(() => {
    state.keyword = value;
    renderList();
  }, 120);

  // 글자 하나마다 보내면 한 번의 검색이 여러 건으로 잡히므로,
  // 타이핑이 멈춘 뒤에 한 번만 보낸다
  clearTimeout(searchTrackTimer);
  searchTrackTimer = setTimeout(() => {
    const kw = value.trim();
    if (kw) trackFilter("search", kw);
  }, 800);
});

$("reset").addEventListener("click", () => {
  // 선택만 되돌리고, 사용자가 만든 카테고리 설정은 유지한다
  state.site = ALL;
  state.category = ALL;
  state.customId = null;
  state.keyword = "";
  $keyword.value = "";
  renderAll();
});

(async function init() {
  loadStorage();
  state.notices = await loadNotices();
  collectFacets();
  renderUpdated();
  renderAll();
  // 가설 H1·H3 의 분모. "공지 목록을 실제로 본 횟수"
  track("feed_view", { notice_count: state.notices.length });
})();
