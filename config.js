/* Supabase 연결 정보.
   anon(public) key 는 RLS(행 단위 보안)로 읽기만 허용되도록 설계된 값이라
   브라우저 코드에 그대로 노출해도 안전하며, 이 파일은 커밋해도 됩니다.
   절대 이 파일에 service_role 키를 넣지 마세요 (그건 크롤러 서버 쪽 비밀입니다). */
window.SUPABASE_CONFIG = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY",
};
