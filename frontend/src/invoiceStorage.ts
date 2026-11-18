// Soneja Electronics - IndexedDB & Client-side Storage for Large Attachments & Data Store
// Bypasses browser 5MB localStorage limit by storing unlimited structured data in IndexedDB
import { getActiveFirebaseConfig, DEFAULT_FIREBASE_CONFIG } from "./firebaseConfig";

export interface InvoiceAttachment {
  name: string;
  type: string;
  size: number;
  data_url: string;
  uploaded_at: string;
  has_attachment?: boolean;
}

const DB_NAME = "soneja_invoices_db";
const DB_VERSION = 2;
const STORE_INVOICES = "invoices";
const STORE_DATA = "data_store";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      return reject(new Error("IndexedDB not available"));
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_INVOICES)) {
        db.createObjectStore(STORE_INVOICES, { keyPath: "order_id" });
      }
      if (!db.objectStoreNames.contains(STORE_DATA)) {
        db.createObjectStore(STORE_DATA, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

// ---------------------------------------------------------------------------
// Generic Collection Storage (Unlimited storage for orders, products, etc.)
// ---------------------------------------------------------------------------
export async function saveToIndexedDB(key: string, data: any): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DATA, "readwrite");
      const store = tx.objectStore(STORE_DATA);
      const req = store.put({ key, data, updated_at: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("Failed to write to IndexedDB:", e);
  }
}

export async function getFromIndexedDB<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_DATA, "readonly");
      const store = tx.objectStore(STORE_DATA);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve(req.result ? (req.result.data as T) : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invoice Local IndexedDB Storage
// ---------------------------------------------------------------------------
export async function saveInvoiceToIdb(orderId: string, invoice: InvoiceAttachment): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INVOICES, "readwrite");
      const store = tx.objectStore(STORE_INVOICES);
      const req = store.put({ order_id: orderId, invoice });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("Failed to write invoice to IndexedDB:", err);
  }
}

export async function getInvoiceFromIdb(orderId: string): Promise<InvoiceAttachment | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_INVOICES, "readonly");
      const store = tx.objectStore(STORE_INVOICES);
      const req = store.get(orderId);
      req.onsuccess = () => {
        resolve(req.result ? req.result.invoice : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteInvoiceFromIdb(orderId: string): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_INVOICES, "readwrite");
      const store = tx.objectStore(STORE_INVOICES);
      const req = store.delete(orderId);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Invoice Cloud RTDB Sync (Dedicated node to keep main orders payload small)
// ---------------------------------------------------------------------------
function getCloudDbUrl(): string {
  const config = getActiveFirebaseConfig() || DEFAULT_FIREBASE_CONFIG;
  return config?.databaseURL || `https://${config?.projectId || "soneja-electronics"}-default-rtdb.firebaseio.com`;
}

export async function fetchInvoiceFromCloud(orderId: string): Promise<InvoiceAttachment | null> {
  try {
    const url = getCloudDbUrl();
    const res = await fetch(`${url}/invoices/${encodeURIComponent(orderId)}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data as InvoiceAttachment | null;
  } catch (err) {
    console.warn("Failed to fetch invoice from cloud:", err);
    return null;
  }
}

export async function syncInvoiceToCloud(orderId: string, invoice: InvoiceAttachment): Promise<void> {
  try {
    const url = getCloudDbUrl();
    await fetch(`${url}/invoices/${encodeURIComponent(orderId)}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invoice),
    });
  } catch (err) {
    console.warn("Failed to sync invoice to cloud:", err);
  }
}

export async function deleteInvoiceFromCloud(orderId: string): Promise<void> {
  try {
    const url = getCloudDbUrl();
    await fetch(`${url}/invoices/${encodeURIComponent(orderId)}.json`, {
      method: "DELETE",
    });
  } catch (err) {
    console.warn("Failed to delete invoice from cloud:", err);
  }
}

// High-level helpers that combine local IndexedDB & Cloud RTDB
export async function getInvoiceAttachment(orderId: string): Promise<InvoiceAttachment | null> {
  // 1. Try local IndexedDB (instant, zero network latency)
  const idbInv = await getInvoiceFromIdb(orderId);
  if (idbInv && idbInv.data_url) return idbInv;

  // 2. Fetch from Firebase RTDB cloud invoice storage
  const cloudInv = await fetchInvoiceFromCloud(orderId);
  if (cloudInv && cloudInv.data_url) {
    // Cache locally into IndexedDB for instant offline access next time
    await saveInvoiceToIdb(orderId, cloudInv);
    return cloudInv;
  }

  return null;
}

export async function saveInvoiceAttachment(orderId: string, invoice: InvoiceAttachment): Promise<void> {
  // 1. Save to local IndexedDB (bypasses 5MB localStorage limit)
  await saveInvoiceToIdb(orderId, invoice);
  // 2. Save to Cloud RTDB under dedicated invoices node
  await syncInvoiceToCloud(orderId, invoice);
}

export async function deleteInvoiceAttachment(orderId: string): Promise<void> {
  await deleteInvoiceToIdbSafe(orderId);
  await deleteInvoiceFromCloud(orderId);
}

async function deleteInvoiceToIdbSafe(orderId: string) {
  try {
    await deleteInvoiceFromIdb(orderId);
  } catch {}
}

// ---------------------------------------------------------------------------
// File & Image Utilities
// ---------------------------------------------------------------------------
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// Compress images automatically so camera snapshots (e.g. 5MB) scale cleanly to ~150-300KB
export async function compressImageIfNeeded(
  file: File,
  maxDim = 1600,
  quality = 0.82
): Promise<{ dataUrl: string; size: number }> {
  if (!file.type.startsWith("image/") || file.type.includes("svg")) {
    const rawData = await readFileAsDataUrl(file);
    return { dataUrl: rawData, size: file.size };
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          const fallback = e.target?.result as string;
          return resolve({ dataUrl: fallback, size: file.size });
        }

        ctx.drawImage(img, 0, 0, width, height);
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        const compressed = canvas.toDataURL(mime, quality);
        const base64Len = compressed.length - (compressed.indexOf(",") + 1);
        const estSize = Math.round((base64Len * 3) / 4);

        resolve({ dataUrl: compressed, size: estSize });
      };
      img.onerror = () => {
        const fallback = e.target?.result as string;
        resolve({ dataUrl: fallback, size: file.size });
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}
