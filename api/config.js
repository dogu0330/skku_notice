// Vercel 서버리스 함수(Node.js). /api/config.js 로 요청이 오면
// Vercel 프로젝트에 설정된 환경변수(SUPABASE_URL, SUPABASE_ANON_KEY)를
// 읽어서 브라우저가 바로 실행할 수 있는 JS 코드로 내려준다.
//
// anon key 는 RLS(행 단위 보안)로 읽기만 허용되도록 설계된 공개용 키라
// 이렇게 응답으로 내려줘도 안전하다. service_role 키는 여기서 다루지 않는다
// (그건 크롤러가 서버 환경에서만 쓰는 별도의 비밀 값이다).
// Supabase 대시보드 예제 코드에는 종종 /rest/v1 이 붙은 URL이 나와서
// 환경변수에 그걸 그대로 넣는 실수가 흔하다. supabase-js 는 프로젝트 기본
// URL(https://xxx.supabase.co)을 기대하고 내부적으로 /rest/v1 을 붙이므로,
// 여기서 미리 잘라내 어떤 값이 들어와도 동작하게 한다.
function normalizeProjectUrl(raw) {
  let url = (raw || "").trim().replace(/\/+$/, "");
  url = url.replace(/\/rest(\/v1)?$/i, "");
  return url;
}

module.exports = (req, res) => {
  const config = {
    url: normalizeProjectUrl(process.env.SUPABASE_URL),
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  };

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  // 환경변수를 바꾼 뒤 브라우저 캐시 때문에 예전 값이 계속 보이는 걸 방지한다.
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(`window.SUPABASE_CONFIG = ${JSON.stringify(config)};\n`);
};
