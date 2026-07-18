import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";



// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Initialize App Check (ReCAPTCHA v3)
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
if (typeof window !== "undefined" && siteKey) {
  console.log("Initializing Firebase App Check...");
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true
    });
    console.log("Firebase App Check initialized successfully!");
  } catch (err) {
    console.error("Firebase App Check initialization failed:", err);
  }
}

// Initialize Realtime Database
export const db = getDatabase(app);
