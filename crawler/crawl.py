# -*- coding: utf-8 -*-
"""
성균관대 공지사항 통합 크롤러 (MVP)

사용법:
    pip install requests beautifulsoup4
    python crawler/crawl.py            # 사이트별 1페이지(10건)씩 수집
    python crawler/crawl.py --pages 3  # 사이트별 3페이지씩 수집

수집할 사이트 목록은 crawler/sites.json 에 있다.
학과 사이트를 추가하려면 그 파일에 name / list_url 을 한 줄 넣고 다시 실행하면 된다.

결과는 data/notices.json (원본) 과 data/notices.js (file:// 로 열 때용) 에 저장된다.
같은 공지가 중복 저장되지 않도록 original_url 기준으로 upsert 한다.

Supabase 연동 (선택):
    환경변수 SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 를 설정해두면,
    수집이 끝난 뒤 결과를 Supabase notices 테이블에도 동기화한다.
    두 값이 없으면 이 단계는 조용히 건너뛰고 지금처럼 JSON 파일만 갱신한다.

    SERVICE_ROLE_KEY 는 RLS 를 무시할 수 있는 비밀 키이므로 절대 커밋하지 말 것.
    로컬에서는 셸 환경변수로, 자동화(GitHub Actions 등)에서는 시크릿으로 주입한다.

    이미 만들어둔 data/notices.json 을 다시 크롤링하지 않고 그대로 Supabase 에
    올리고 싶다면: python crawler/crawl.py --sync-existing
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

# 윈도우 콘솔(cp949)에서 한글 로그가 깨지지 않도록 표준출력을 UTF-8로 강제한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import requests
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
JSON_PATH = os.path.join(DATA_DIR, "notices.json")
JS_PATH = os.path.join(DATA_DIR, "notices.js")
SITES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sites.json")

# 게시판 종류별 셀렉터 프리셋.
# 성균관대 사이트는 대부분 동일한 CMS(jwxe) 를 쓰기 때문에 프리셋 하나로 커버된다.
# 구조가 다른 게시판이 생기면 여기에 프리셋을 추가하고 sites.json 에서 preset 으로 지정하면 된다.
SELECTOR_PRESETS = {
    "jwxe": {
        "list_item": "ul.board-list-wrap > li",
        "title_link": "dt.board-list-content-title a",
        "category": "span.c-board-list-category",
        "info_items": "dd.board-list-content-info li",
        "date_index": 2,  # 정보 목록에서 날짜가 위치하는 순서 (0: 번호, 1: 작성자, 2: 날짜)
    }
}
DEFAULT_PRESET = "jwxe"

# sites.json 을 읽지 못했을 때 사용하는 기본 사이트 목록
FALLBACK_SITES = [
    {
        "name": "본교",
        "list_url": "https://www.skku.edu/skku/campus/skk_comm/notice01.do",
        "preset": "jwxe",
        "page_size": 10,
    },
    {
        "name": "기계공학부",
        "list_url": "https://mech.skku.edu/me/notice.do",
        "preset": "jwxe",
        "page_size": 10,
    },
    {
        "name": "학생성공센터",
        "list_url": "https://success.skku.edu/success/notice.do",
        "preset": "jwxe",
        "page_size": 10,
    },
]


def normalize_supabase_base(url):
    """대시보드 예제를 복붙해 /rest/v1 이 섞여 들어와도 프로젝트 기본 URL로 정리한다."""
    base = (url or "").rstrip("/")
    for suffix in ("/rest/v1", "/rest"):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base


def build_site_configs(entries):
    """[{name, list_url, preset, page_size, selectors?}, ...] 목록을 크롤러가 쓰는
    {이름: 설정} 딕셔너리로 변환한다. sites.json 항목과 Supabase sites 테이블 행 모두
    이 형태로 들어온다."""
    configs = {}
    for entry in entries:
        name = (entry.get("name") or "").strip()
        list_url = (entry.get("list_url") or "").strip()
        if not name or not list_url:
            print("[!] name 또는 list_url 이 비어 있는 항목을 건너뜁니다: %r" % (entry,))
            continue
        preset_name = entry.get("preset") or DEFAULT_PRESET
        selectors = dict(SELECTOR_PRESETS.get(preset_name, SELECTOR_PRESETS[DEFAULT_PRESET]))
        if preset_name not in SELECTOR_PRESETS:
            print("[!] '%s' 프리셋을 찾을 수 없어 %s 로 대체합니다." % (preset_name, DEFAULT_PRESET))
        # 프리셋 일부만 덮어쓰고 싶을 때를 위한 개별 셀렉터 지정
        if isinstance(entry.get("selectors"), dict):
            selectors.update(entry["selectors"])
        configs[name] = {
            "list_url": list_url,
            "selectors": selectors,
            "page_size": entry.get("page_size", 10),  # article.offset 증가 단위
        }
    return configs


def load_sites_from_supabase():
    """Supabase sites 테이블에서 활성화된 사이트 목록을 가져온다.
    사용자가 화면에서 직접 추가한 학과도 이 테이블에 들어있으므로,
    Supabase 연동이 켜져 있으면 sites.json 대신 이쪽을 우선 사용해
    자동 크롤링(GitHub Actions 등)이 새로 추가된 사이트도 함께 돌게 한다."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None

    endpoint = normalize_supabase_base(url) + "/rest/v1/sites"
    headers = {"apikey": key, "Authorization": "Bearer %s" % key}
    params = {"select": "name,list_url,preset,page_size", "is_active": "eq.true"}
    try:
        res = requests.get(endpoint, headers=headers, params=params, timeout=15)
        res.raise_for_status()
        # res.json() 은 응답 헤더에 charset 이 없으면 requests 가 인코딩을 추측하는데,
        # 한글처럼 짧은 멀티바이트 문자열에서 이 추측이 종종 틀려 글자가 깨진다.
        # Supabase(PostgREST)는 항상 UTF-8 로 응답하므로 직접 명시해서 디코딩한다.
        rows = json.loads(res.content.decode("utf-8"))
    except (requests.RequestException, ValueError, UnicodeDecodeError) as exc:
        print("[!] Supabase sites 조회 실패, sites.json 으로 대체합니다: %s" % exc)
        return None

    if not isinstance(rows, list) or not rows:
        print("[!] Supabase sites 테이블이 비어 있어 sites.json 으로 대체합니다.")
        return None
    return rows


def load_sites_json():
    raw = None
    try:
        with open(SITES_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as exc:
        print("[!] sites.json 을 읽지 못해 기본 목록을 사용합니다: %s" % exc)

    if isinstance(raw, dict) and isinstance(raw.get("sites"), list):
        return raw["sites"]
    if isinstance(raw, list):  # sites 키 없이 배열만 적은 경우도 허용
        return raw
    return FALLBACK_SITES


def load_site_configs():
    """수집할 사이트 목록을 {이름: 설정} 형태로 돌려준다.

    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 설정돼 있으면 Supabase sites
    테이블을 우선 사용하고(사용자가 추가한 학과 포함), 없거나 비어 있으면
    crawler/sites.json 으로 대체한다.
    """
    entries = load_sites_from_supabase()
    if entries is None:
        entries = load_sites_json()
    return build_site_configs(entries)


SITE_CONFIGS = load_site_configs()

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def canonicalize(url):
    """목록 페이지마다 붙는 offset 파라미터를 제거해
    같은 공지가 다른 URL로 중복 저장되는 것을 막는다."""
    return re.sub(r"&(article\.offset|articleLimit)=[^&]*", "", url)


def make_id(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def clean(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def fetch_page(list_url, offset, timeout=15):
    params = {"mode": "list", "article.offset": offset, "articleLimit": 10}
    res = requests.get(list_url, params=params, headers=HEADERS, timeout=timeout)
    res.raise_for_status()
    res.encoding = res.apparent_encoding or "utf-8"
    return res.text


def parse_list(html, site_name, list_url, selectors):
    soup = BeautifulSoup(html, "html.parser")
    notices = []
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    for li in soup.select(selectors["list_item"]):
        link = li.select_one(selectors["title_link"])
        if link is None or not link.get("href"):
            continue

        title = clean(link.get_text())
        if not title:
            continue

        original_url = canonicalize(urljoin(list_url, link["href"]))

        cat_el = li.select_one(selectors["category"])
        category = clean(cat_el.get_text()).strip("[]") if cat_el else None
        if not category:
            category = None

        published_date = None
        info_texts = [clean(x.get_text()) for x in li.select(selectors["info_items"])]
        idx = selectors.get("date_index", 2)
        if len(info_texts) > idx and DATE_RE.fullmatch(info_texts[idx] or ""):
            published_date = info_texts[idx]
        else:  # 순서가 다를 경우를 대비한 예비 탐색
            for text in info_texts:
                m = DATE_RE.search(text or "")
                if m:
                    published_date = m.group(0)
                    break

        notices.append(
            {
                "id": make_id(original_url),
                "title": title,
                "source_site": site_name,
                "category": category,
                "published_date": published_date,
                "original_url": original_url,
                "crawled_at": now,
            }
        )

    return notices


def crawl_site(site_name, config, pages):
    collected = []
    page_size = config.get("page_size", 10)
    for page in range(pages):
        offset = page * page_size
        try:
            html = fetch_page(config["list_url"], offset)
        except Exception as exc:  # 한 사이트가 실패해도 나머지는 계속 수집한다
            print("  [!] %s offset=%d 요청 실패: %s" % (site_name, offset, exc))
            break
        items = parse_list(html, site_name, config["list_url"], config["selectors"])
        print("  - offset=%d → %d건" % (offset, len(items)))
        if not items:
            break
        collected.extend(items)
        time.sleep(0.5)  # 서버 부담을 줄이기 위한 간격
    return collected


def load_existing():
    if not os.path.exists(JSON_PATH):
        return []
    try:
        with open(JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (ValueError, OSError):
        return []


def upsert(existing, incoming):
    """original_url 기준으로 병합. 기존 항목은 새 정보로 갱신하고, 새 항목은 추가한다."""
    merged = {}
    for item in existing:
        url = item.get("original_url")
        if url:
            merged[url] = item

    added, updated = 0, 0
    for item in incoming:
        url = item["original_url"]
        if url in merged:
            first_seen = merged[url].get("crawled_at")
            merged[url] = dict(item)
            # 처음 수집한 시각을 유지하면 "언제부터 있던 공지인지" 추적할 수 있다
            merged[url]["crawled_at"] = item["crawled_at"]
            merged[url]["first_seen_at"] = merged[url].get("first_seen_at") or first_seen
            updated += 1
        else:
            item = dict(item)
            item["first_seen_at"] = item["crawled_at"]
            merged[url] = item
            added += 1

    result = sorted(
        merged.values(),
        key=lambda n: (n.get("published_date") or "", n.get("title") or ""),
        reverse=True,
    )
    return result, added, updated


def save(notices):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(notices, f, ensure_ascii=False, indent=2)
    with open(JS_PATH, "w", encoding="utf-8") as f:
        f.write("/* 자동 생성 파일 - crawler/crawl.py 실행 결과 */\n")
        f.write("window.NOTICES = ")
        json.dump(notices, f, ensure_ascii=False, indent=2)
        f.write(";\n")


def sync_to_supabase(notices):
    """수집 결과를 Supabase notices 테이블에 업서트한다.

    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 없으면 조용히 건너뛴다.
    id(=original_url 해시)를 기본키로 쓰기 때문에, PostgREST 의
    'Prefer: resolution=merge-duplicates' 만으로 기존 행을 그대로 갱신할 수 있다.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("[i] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없어 Supabase 동기화를 건너뜁니다.")
        return

    endpoint = normalize_supabase_base(url) + "/rest/v1/notices"
    headers = {
        "apikey": key,
        "Authorization": "Bearer %s" % key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    # 컬럼에 없는 필드를 보내면 400 이 나므로 스키마에 맞게 정리한다.
    columns = {
        "id",
        "title",
        "source_site",
        "category",
        "published_date",
        "original_url",
        "crawled_at",
        "first_seen_at",
    }

    batch_size = 200
    for i in range(0, len(notices), batch_size):
        batch = [{k: v for k, v in n.items() if k in columns} for n in notices[i : i + batch_size]]
        try:
            res = requests.post(endpoint, headers=headers, data=json.dumps(batch), timeout=30)
        except requests.RequestException as exc:
            print("[!] Supabase 동기화 요청 실패: %s" % exc)
            return
        if not res.ok:
            print(
                "[!] Supabase 동기화 실패(%d) url=%s: %s"
                % (res.status_code, endpoint, res.text[:300])
            )
            return

    print("[+] Supabase 동기화 완료: %d건 → %s" % (len(notices), url))


def main():
    parser = argparse.ArgumentParser(description="성균관대 공지 통합 크롤러")
    parser.add_argument("--pages", type=int, default=1, help="사이트당 수집할 페이지 수")
    parser.add_argument(
        "--sites",
        nargs="*",
        default=list(SITE_CONFIGS.keys()),
        help="수집할 사이트 이름 (기본: 전체)",
    )
    parser.add_argument(
        "--sync-existing",
        action="store_true",
        help="새로 크롤링하지 않고, data/notices.json 을 그대로 Supabase 에 동기화만 한다",
    )
    args = parser.parse_args()

    if args.sync_existing:
        existing = load_existing()
        if not existing:
            print("[!] data/notices.json 이 비어 있습니다.")
            return 1
        sync_to_supabase(existing)
        return 0

    incoming = []
    for site_name in args.sites:
        config = SITE_CONFIGS.get(site_name)
        if not config:
            print("[!] 알 수 없는 사이트: %s" % site_name)
            continue
        print("[*] %s 수집 중..." % site_name)
        incoming.extend(crawl_site(site_name, config, args.pages))

    if not incoming:
        print("[!] 수집된 공지가 없습니다.")
        return 1

    existing = load_existing()
    merged, added, updated = upsert(existing, incoming)
    save(merged)
    print(
        "[+] 저장 완료: 총 %d건 (신규 %d, 갱신 %d) → %s"
        % (len(merged), added, updated, JSON_PATH)
    )
    sync_to_supabase(merged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
