# 성대 공지 모아보기 (MVP)

성균관대 본교 · 기계공학부 · 학생성공센터 공지사항을 한 페이지에서 모아보고
출처 · 카테고리 · 키워드로 필터링하는 정적 웹사이트입니다.

## 구조

```
index.html          메인 화면 (유일한 페이지)
styles.css          스타일
app.js              필터 · 검색 · 렌더링 로직
api/config.js       Vercel 서버리스 함수. 환경변수(SUPABASE_URL/SUPABASE_ANON_KEY)를 읽어 브라우저에 내려줌
data/notices.json   크롤링 결과 (Supabase 미설정 시 사용하는 원본 데이터)
data/notices.js     같은 데이터를 window.NOTICES 로 담은 파일 (file:// 로 열 때 사용)
supabase/schema.sql Supabase 테이블 · RLS 정책 정의
crawler/sites.json  수집할 사이트 목록 (여기만 고치면 사이트 추가 완료)
crawler/crawl.py    파이썬 크롤러 (requests + BeautifulSoup, 끝나면 Supabase 에도 동기화)
```

## 실행

- 그냥 `index.html` 을 브라우저로 열면 됩니다. (`data/notices.js` 를 읽음)
- 로컬 서버로 띄우려면: `python -m http.server 8000` 후 http://localhost:8000

## 내 학과 공지 사이트 추가하기

`crawler/sites.json` 의 `sites` 배열에 항목을 하나 추가하고 크롤러를 다시 실행하면 됩니다.
파이썬 코드는 건드릴 필요가 없습니다.

```json
{
  "name": "소프트웨어학과",
  "list_url": "https://sw.skku.edu/sw/notice.do",
  "preset": "jwxe",
  "page_size": 10
}
```

- `name` : 화면의 출처 배지에 표시될 이름. 출처 필터 버튼은 데이터에서 자동으로 만들어지므로
  크롤러를 돌리고 새로고침하면 새 학과가 바로 나타납니다.
- `list_url` : 공지 목록 페이지 주소를 그대로 넣습니다.
- `preset` : 게시판 종류. 성균관대 학과 사이트는 대부분 같은 CMS(jwxe)를 쓰므로 `"jwxe"` 로 두면 됩니다.
  구조가 다른 게시판이라면 `crawl.py` 의 `SELECTOR_PRESETS` 에 프리셋을 추가하거나,
  항목 안에 `"selectors": { ... }` 로 일부 셀렉터만 덮어쓸 수 있습니다.

브라우저에서 직접 학과 사이트를 읽어오는 방식은 쓰지 않았습니다. 학교 서버가 CORS 를 허용하지 않아
정적 페이지에서는 크롤링이 차단되기 때문에, 수집은 크롤러가 맡고 화면은 그 결과만 읽습니다.

## 카테고리 커스텀 (브라우저에서)

- **카테고리 → 관리** : 크롤링된 카테고리(채용/모집, 장학, 대학원 …) 중 관심 없는 항목을 꺼두면
  해당 공지가 목록에서 아예 빠집니다.
- **내 카테고리 → ＋ 추가** : 이름과 키워드(쉼표 구분)를 넣어 나만의 분류를 만듭니다.
  예) 이름 `장학금`, 키워드 `장학, 등록금, 학자금` → 제목에 그 단어가 들어간 공지만 묶어 봅니다.
  칩의 `×` 로 삭제할 수 있습니다.
- 두 설정 모두 브라우저 `localStorage` 에 저장되어 다음 방문에도 유지됩니다.
  `초기화` 버튼은 선택만 되돌리고 만들어둔 카테고리는 지우지 않습니다.

## 크롤러

```bash
pip install requests beautifulsoup4
python crawler/crawl.py            # 사이트당 1페이지(10건)
python crawler/crawl.py --pages 3  # 사이트당 3페이지
python crawler/crawl.py --sites 본교
```

- `original_url` 기준으로 중복을 확인해 병합(upsert)하므로 여러 번 돌려도 안전합니다.
  목록 페이지마다 붙는 `article.offset` 파라미터는 제거하고 저장해, 상단 고정 공지가
  페이지마다 중복 수집되지 않습니다.
- 실행하면 `data/notices.json` 과 `data/notices.js` 가 함께 갱신됩니다.

## 배포

빌드 과정이 없는 정적 사이트라 폴더 그대로 Vercel / Netlify 에 올리면 됩니다.

## Supabase 로 DB 관리하기

지금은 `data/notices.json` 파일이 데이터 원본이지만, Supabase 를 연결하면 화면이 그 대신
Supabase 테이블을 읽습니다. (연결이 안 돼 있으면 지금처럼 JSON 파일로 자동 대체됩니다.)

### 1) 프로젝트 만들고 스키마 적용

1. [supabase.com](https://supabase.com) 에서 새 프로젝트 생성
2. 대시보드 → SQL Editor → `supabase/schema.sql` 내용을 붙여넣고 실행
   (`notices`, `sites` 테이블 생성 + 읽기 전용 RLS 정책 + 기존 3개 사이트 시드 데이터)
3. 대시보드 → Project Settings → API 에서 두 값을 확인
   - **Project URL**
   - **anon / public key** (읽기만 허용되는 공개 키)

### 2) 화면이 Supabase 를 보게 하기

값을 코드에 커밋하지 않고, Vercel 대시보드 → 프로젝트 → **Settings → Environment Variables** 에서
아래 두 개를 등록합니다 (이름이 정확히 일치해야 `api/config.js` 가 읽습니다).

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon / public key |

등록 후 Vercel에서 재배포(Redeploy)하면 반영됩니다. `api/config.js` 는 요청이 올 때마다
이 환경변수를 읽어 `window.SUPABASE_CONFIG` 를 만들어 내려주는 서버리스 함수라서,
저장소에는 실제 URL/키가 전혀 남지 않습니다. (환경변수가 비어 있으면 자동으로
`data/notices.json` 로 대체됩니다.)

### 3) 기존 JSON 데이터를 한 번 옮기기

지금까지 크롤링해둔 `data/notices.json` 을 다시 크롤링하지 않고 그대로 Supabase 에 넣습니다.

```bash
export SUPABASE_URL="https://xxxxxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi..."   # Project Settings → API → service_role (비밀)
python crawler/crawl.py --sync-existing
```

**`service_role` 키는 RLS 를 무시할 수 있는 비밀 키입니다. 저장소나 Vercel의 `SUPABASE_ANON_KEY`
자리에 절대 넣지 말고, 크롤러를 실행하는 로컬 셸 또는 CI 시크릿으로만 사용하세요.**

### 4) 이후 크롤링부터는 자동으로 Supabase 에도 동기화

같은 두 환경변수(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)가 설정된 상태로
`python crawler/crawl.py` 를 돌리면, JSON 파일 저장 후 Supabase `notices` 테이블에도
`original_url` 기준으로 upsert 됩니다. 환경변수가 없으면 이 단계는 조용히 건너뛰고
지금처럼 JSON 파일만 갱신합니다 — 즉 Supabase 를 아직 안 만들었어도 기존 방식 그대로 동작합니다.
