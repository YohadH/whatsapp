// Public marketing homepage. The landing page is a fully self-contained document
// (its own fonts + global CSS reset) that would clobber the app's Tailwind if
// injected inline, so it lives verbatim under /public/landing/ and is shown here
// in a full-viewport frame. Its "כניסה למערכת" button navigates the top window to
// /dashboard (target="_top"), which routes to /login when signed-out.
export default function Landing() {
  return (
    <iframe
      src="/landing/"
      title="HeyIL — סוכן וואטסאפ בעברית לעסקים"
      style={{ border: 0, display: 'block', width: '100vw', height: '100vh' }}
    />
  );
}
