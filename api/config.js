// Vercel 서버리스 함수(Node.js). /api/config.js 로 요청이 오면
// Vercel 프로젝트에 설정된 환경변수(SUPABASE_URL, SUPABASE_ANON_KEY)를
// 읽어서 브라우저가 바로 실행할 수 있는 JS 코드로 내려준다.
//
// anon key 는 RLS(행 단위 보안)로 읽기만 허용되도록 설계된 공개용 키라
// 이렇게 응답으로 내려줘도 안전하다. service_role 키는 여기서 다루지 않는다
// (그건 크롤러가 서버 환경에서만 쓰는 별도의 비밀 값이다).
module.exports = (req, res) => {
  const config = {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  };

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(`window.SUPABASE_CONFIG = ${JSON.stringify(config)};\n`);
};
