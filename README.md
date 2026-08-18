# 성대 공지 모아보기 (MVP)

성균관대 본교 · 기계공학부 · 학생성공센터 공지사항을 한 페이지에서 모아보고
출처 · 카테고리 · 키워드로 필터링하는 정적 웹사이트입니다.

## 구조

```
index.html          메인 화면 (유일한 페이지)
styles.css          스타일
app.js              필터 · 검색 · 렌더링 로직
data/notices.json   크롤링 결과 (원본 데이터)
data/notices.js     같은 데이터를 window.NOTICES 로 담은 파일 (file:// 로 열 때 사용)
crawler/sites.json  수집할 사이트 목록 (여기만 고치면 사이트 추가 완료)
crawler/crawl.py    파이썬 크롤러 (requests + BeautifulSoup)
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
