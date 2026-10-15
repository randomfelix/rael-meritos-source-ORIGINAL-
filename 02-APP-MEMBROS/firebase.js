import "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const config = globalThis.RAEL_FIREBASE_CONFIG;
if (!config || !config.apiKey || config.apiKey.startsWith("COLE_AQUI")) {
  console.warn("Configure firebase-config.js antes de usar o R.A.E.L. Méritos.");
}

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const syntheticEmail = username => `${username.trim().toLowerCase()}@members.rael.invalid`;
export const normalizeUsername = username => username.trim().toLowerCase();
