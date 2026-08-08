// Meta Embedded Signup launcher. Loads the Facebook JS SDK once, opens the
// signup popup, captures the customer's phone_number_id + waba_id from the
// postMessage, and resolves with those plus the OAuth `code` the backend
// exchanges for a token.

let sdkPromise = null;

function loadSdk(appId, graphVersion) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = function () {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('טעינת ה-SDK של Meta נכשלה'));
    document.body.appendChild(s);
  });
  return sdkPromise;
}

function isFacebookOrigin(origin) {
  try {
    return /(^|\.)facebook\.com$/.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Returns { code, phoneNumberId, wabaId } or rejects (cancel/error).
export async function launchEmbeddedSignup({ appId, configId, graphVersion }) {
  const FB = await loadSdk(appId, graphVersion);

  return new Promise((resolve, reject) => {
    let sessionData = null; // { phone_number_id, waba_id } from the signup postMessage

    const onMessage = (event) => {
      if (!isFacebookOrigin(event.origin)) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'FINISH') sessionData = data.data;
        else if (data.event === 'CANCEL') {
          cleanup();
          reject(new Error('התהליך בוטל'));
        }
      } catch {
        /* ignore non-JSON messages */
      }
    };
    const cleanup = () => window.removeEventListener('message', onMessage);
    window.addEventListener('message', onMessage);

    FB.login(
      (response) => {
        const code = response?.authResponse?.code;
        cleanup();
        if (!code) return reject(new Error('לא התקבל אישור מ-Meta (ייתכן שהחלון נסגר)'));
        if (!sessionData?.phone_number_id || !sessionData?.waba_id) {
          return reject(new Error('לא התקבלו פרטי המספר מ-Meta'));
        }
        resolve({ code, phoneNumberId: sessionData.phone_number_id, wabaId: sessionData.waba_id });
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      }
    );
  });
}

// One-click Messenger + Instagram connect via Facebook Login. Requests the messaging
// scopes and resolves with the user's access token; the backend (POST /api/settings/
// meta/connect) exchanges it for the Page token + linked Instagram account. One Page
// connection enables BOTH Messenger and Instagram.
export async function launchMetaConnect({ appId, graphVersion }) {
  const FB = await loadSdk(appId, graphVersion);
  return new Promise((resolve, reject) => {
    FB.login(
      (response) => {
        const token = response?.authResponse?.accessToken;
        if (token) resolve(token);
        else reject(new Error('החיבור בוטל'));
      },
      { scope: 'pages_show_list,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages', return_scopes: true }
    );
  });
}
