"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  deleteDoc,
  addDoc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  or,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentSnapshot,
  setDoc,
  writeBatch, // ✅ added
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";

type Customer = {
  id: string;
  customerNo: string;
  customerName: string;
  address1?: string;
  city?: string;
  state?: string;
  stateUpper?: string;
  phone?: string;

  dateLastActivity?: any;
  lastActivityDate?: any;
  lastActivity?: any;
  date_last_activity?: any;
  lastInvoiceDate?: any;
  lastSaleDate?: any;

  activityDays?: number | string;
  daysSinceLastActivity?: number | string;
  lastActivityDays?: number | string;
  daysInactive?: number | string;
  inactiveDays?: number | string;

  buyerEmail?: string;
  buyer2Email?: string;

  creditHoldBool?: boolean;
  lastActivityBucket?: string;
  status?: "A" | "I" | string;

  currentBalance?: string | number;
  udf250TotalSales?: string | number;

  email?: string;
};

type Salesperson = {
  uid: string;
  name: string;
  salespersonNo: string;
  role?: string;
};

type Note = {
  id: string;
  text: string;
  pinned?: boolean;
  followUpDate?: any;
  createdAt?: any;
  updatedAt?: any;
  createdByUid?: string;
  createdByName?: string;
  updatedByUid?: string;

  // ✅ optional metadata for group notes
  isGroupNote?: boolean;
  groupId?: string | null;
  groupNoteId?: string | null;
  sourceCustomerNo?: string | null;
};

type SalesmanGroup = {
  id: string;
  ownerUid: string;
  ownerSalespersonNo?: string;
  name: string;
  createdAt?: any;
  updatedAt?: any;