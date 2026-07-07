import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCgzmW06ymrvgPILMDrGxUKsJyC3amHY3w",
  authDomain: "instant-f2b0b.firebaseapp.com",
  databaseURL: "https://instant-f2b0b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "instant-f2b0b",
  storageBucket: "instant-f2b0b.firebasestorage.app",
  messagingSenderId: "1028488215890",
  appId: "1:1028488215890:web:1f2831c2474f52a953ce8b"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Initialize Realtime Database
export const db = getDatabase(app);
