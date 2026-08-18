-- 성대 공지 모아보기 - Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에서 그대로 실행하면 됩니다.

-- 1) 공지 사이트 목록 (기존 crawler/sites.json 을 대체)
create table if not exists public.sites (
  id          bigint generated always as identity primary key,
  name        text not null,               -- 화면에 보일 출처 이름 (예: 기계공학부)
  list_url    text not null,               -- 게시판 목록 페이지 URL
  preset      text not null default 'jwxe', -- 셀렉터 프리셋 (crawler/crawl.py 의 SELECTOR_PRESETS 참고)
  page_size   int not null default 10,
  is_active   boolean not null default true, -- 끄면 크롤링 대상에서 제외
  created_at  timestamptz not null default now()
);

-- 학과 사이트를 스스로 추가할 수 있게 되면서, 어떤 URL이 진짜 식별자가 되어야 하므로
-- 유일성 기준을 name -> list_url 로 옮긴다. (예전 스키마를 이미 적용한 경우를 위한 정리)
alter table public.sites drop constraint if exists sites_name_key;
create unique index if not exists sites_list_url_idx on public.sites (list_url);

-- 2) 공지 (기존 data/notices.json 을 대체)
create table if not exists public.notices (
  id              text primary key,        -- original_url 기반 짧은 해시 (crawler/crawl.py 의 make_id 와 동일 로직)
  title           text not null,
  source_site     text not null,
  category        text,
  published_date  date,
  original_url    text not null unique,
  crawled_at      timestamptz not null default now(),
  first_seen_at   timestamptz not null default now()
);

create index if not exists notices_published_date_idx on public.notices (published_date desc);
create index if not exists notices_source_site_idx on public.notices (source_site);

-- 3) 행 단위 보안(RLS): 누구나 읽기는 가능, 쓰기는 서비스 역할(크롤러)만 가능
alter table public.sites enable row level security;
alter table public.notices enable row level security;

drop policy if exists "sites are publicly readable" on public.sites;
create policy "sites are publicly readable"
  on public.sites for select
  using (true);

drop policy if exists "notices are publicly readable" on public.notices;
create policy "notices are publicly readable"
  on public.notices for select
  using (true);

-- anon/authenticated 역할에는 insert/update/delete 정책을 만들지 않는다.
-- 크롤러와 add-site Edge Function 은 service_role 키로 접속하므로 RLS 를 우회해 쓸 수 있다.

-- 4) 기존 3개 사이트 시드 데이터
insert into public.sites (name, list_url, preset, page_size) values
  ('본교', 'https://www.skku.edu/skku/campus/skk_comm/notice01.do', 'jwxe', 10),
  ('기계공학부', 'https://mech.skku.edu/me/notice.do', 'jwxe', 10),
  ('학생성공센터', 'https://success.skku.edu/success/notice.do', 'jwxe', 10)
on conflict (list_url) do nothing;

-- 5) 사용자가 "사이트 추가"를 제출한 기록 (남용 방지용 속도 제한 + 감사 로그)
--    add-site Edge Function 만 service_role 로 접근하므로 공개 정책은 두지 않는다.
create table if not exists public.site_submissions (
  id          bigint generated always as identity primary key,
  client_ip   text,
  list_url    text not null,
  ok          boolean not null,
  message     text,
  created_at  timestamptz not null default now()
);
create index if not exists site_submissions_ip_time_idx
  on public.site_submissions (client_ip, created_at desc);

alter table public.site_submissions enable row level security;
-- 공개 select/insert 정책 없음 = anon/authenticated 로는 전혀 접근 불가.
