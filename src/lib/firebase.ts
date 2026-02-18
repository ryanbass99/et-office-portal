import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDi-q6LVYK9_ciGzQYUGiFCbkczHxRrJX8",
  authDomain: "et-office-portal.firebaseapp.com",
  projectId: "et-office-portal",
  storageBucket: "et-office-portal.firebasestorage.app",
  messagingSenderId: "399914033210",
  appId: "1:399914033210:web:b12c5984c44ecabd11d503",
};

// Prevent re-initializing on hot reload
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
