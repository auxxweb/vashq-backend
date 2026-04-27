import admin from 'firebase-admin';

let inited = false;

function must(v, name) {
  if (!v) throw new Error(`Missing Firebase env: ${name}`);
  return v;
}

export function initFirebaseAdmin() {
  if (inited) return admin;

  // Prefer explicit credentials from env (works in containers/servers).
  // FIREBASE_PRIVATE_KEY often comes with escaped newlines.
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: must(projectId, 'FIREBASE_PROJECT_ID'),
        clientEmail: must(clientEmail, 'FIREBASE_CLIENT_EMAIL'),
        privateKey: must(privateKey, 'FIREBASE_PRIVATE_KEY'),
      }),
    });
  } else {
    // Fallback to application default credentials (GCP environment / GOOGLE_APPLICATION_CREDENTIALS).
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  inited = true;
  return admin;
}

export function getFirebaseMessaging() {
  const a = initFirebaseAdmin();
  return a.messaging();
}

