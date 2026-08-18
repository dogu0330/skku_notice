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

## 사용자가 직접 학과 사이트 추가하기 (Edge Function)

화면의 **사이트 추가 → ＋ 추가** 에 학과 이름과 게시판 URL을 넣으면, Supabase **Edge Function**
(`add-site`)이 그 페이지를 서버에서 대신 읽어와 파싱한 뒤 `sites` / `notices` 테이블에 저장합니다.
브라우저가 직접 학교 서버에 접속하는 게 아니라서 CORS 문제 없이 동작합니다.

### 배포 (CLI 없이, 대시보드에서)

1. Supabase 대시보드 → **SQL Editor** 에서 `supabase/schema.sql` 을 다시 한 번 실행합니다.
   (`site_submissions` 테이블과 `sites.list_url` 유니크 인덱스가 새로 추가됐습니다. 여러 번
   실행해도 안전하도록 만들어져 있습니다.)
2. 대시보드 → **Edge Functions → New function** → 이름을 정확히 `add-site` 로 생성
3. `supabase/functions/add-site/index.ts` 내용을 그대로 붙여넣고 **Deploy**
4. 별도 설정은 필요 없습니다. `SUPABASE_URL` 과 `SUPABASE_SERVICE_ROLE_KEY` 는 Supabase 가
   모든 Edge Function 에 자동으로 주입해 줍니다.

### 안전장치

- **도메인 제한**: `skku.edu` 로 끝나는 주소만 받습니다. 임의의 외부 사이트를 대신 긁어오는
  용도로 악용되는 것(SSRF)을 막기 위한 최소한의 장치입니다.
- **구조 검증**: 본교/기계공학부/학생성공센터와 같은 게시판(jwxe) 구조가 아니면, 즉 글을
  하나도 못 찾으면 아무것도 저장하지 않고 에러만 돌려줍니다.
- **속도 제한**: 같은 접속 IP가 5분 안에 5번 넘게 시도하면 잠깐 막습니다.
  (`site_submissions` 테이블에 시도 기록이 쌓이는데, 공개 조회 권한은 없습니다.)

사이트를 추가하는 순간에는 딱 한 번만 크롤링됩니다. 그 이후로 새 공지를 계속 받아오는 건
아래 자동 크롤링(GitHub Actions)이 담당합니다.

## 자동 크롤링 (GitHub Actions)

`crawler/crawl.py` 는 이제 `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` 가 설정돼 있으면
`crawler/sites.json` 대신 Supabase `sites` 테이블을 읽습니다. 즉 사용자가 화면에서 추가한
학과도 이 목록에 포함되므로, 아래 워크플로 하나로 기존 사이트 + 사용자 추가 사이트가
전부 정기적으로 다시 크롤링됩니다.

`.github/workflows/crawl.yml` 이 하루 3번(한국시간 07/13/19시) 자동으로 실행되어
크롤링 → `data/notices.json`/`data/notices.js` 갱신 → Supabase `notices` 테이블 동기화 →
바뀐 JSON 파일을 저장소에 자동 커밋까지 합니다.

### 설정

GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret** 에서
두 개를 등록하세요 (Vercel에 등록한 것과 같은 값이지만, GitHub Actions는 별도로 등록해야 합니다).

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 키 (비밀) |

등록만 하면 별도 작업 없이 다음 예정 시각에 자동 실행됩니다. 바로 테스트해보고 싶으면
저장소의 **Actions 탭 → 공지 자동 크롤링 → Run workflow** 로 수동 실행할 수 있습니다.

### 알아둘 점

- 크롤러가 커밋까지 하기 때문에 워크플로 권한을 `contents: write` 로 설정해 뒀습니다.
  저장소 Settings → Actions → General → Workflow permissions 가 "Read and write"로 돼
  있어야 정상적으로 커밋/푸시됩니다(기본값이 그렇지 않다면 여기서 바꿔야 합니다).
- Supabase 비밀번호/키를 등록하기 전까지는 크롤러가 `crawler/sites.json` 으로 자동
  대체되어 동작하므로, 시크릿을 아직 안 넣었어도 워크플로 자체는 실패하지 않습니다.
