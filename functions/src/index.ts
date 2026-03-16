import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";

import os from "os";
import path from "path";
import fs from "fs/promises";

import { createCanvas } from "@napi-rs/canvas";

// pdfjs (loaded via require to avoid TS path/type issues)
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");

initializeApp();

const BUCKET_NAME = "et-office-portal.firebasestorage.app";
const SOURCE_PREFIX = "sales-sheets/";
const THUMB_PREFIX = "sales-sheets-thumbs/";

export const generateSalesSheetThumb = onObjectFinalized(
  {
    bucket: BUCKET_NAME,
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name || "";

    if (!filePath.startsWith(SOURCE_PREFIX)) return;
    if (!filePath.toLowerCase().endsWith(".pdf")) return;

    // Ignore thumbs folder (safety)
    if (filePath.startsWith(THUMB_PREFIX)) return;

    const bucket = getStorage().bucket(BUCKET_NAME);
    const file = bucket.file(filePath);

    const baseName = path.basename(filePath, path.extname(filePath)); // keeps marketing filename
    const thumbPath = `${THUMB_PREFIX}${baseName}.png`;

    logger.info("Generating thumbnail", { filePath, thumbPath });

    const tmpPdf = path.join(os.tmpdir(), `${baseName}.pdf`);
    const tmpPng = path.join(os.tmpdir(), `${baseName}.png`);

    // 1) Download PDF to temp
    await file.download({ destination: tmpPdf });

    try {
      // 2) Render first page using pdfjs + canvas
      const loadingTask = pdfjsLib.getDocument(tmpPdf as any);
      const pdf = await loadingTask.promise;

      const page = await pdf.getPage(1);

      // Scale controls thumb size
      const viewport = page.getViewport({ scale: 2.75 });

      // Render full page first
      const fullCanvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      const fullCtx = fullCanvas.getContext("2d");

      await page.render({
        canvasContext: fullCtx as any,
        viewport,
      }).promise;

      // ---- CROP SETTINGS (tuned for your sales sheets) ----
      // Take a "hero" crop from the top portion.
      // Adjust these if needed after one test.
      const cropX = 0;
      const cropY = 0;
      const cropW = Math.min(
        fullCanvas.width,
        Math.floor(fullCanvas.width * 0.72) // left ~72%
      );
      const cropH = Math.min(
        fullCanvas.height,
        Math.floor(fullCanvas.height * 0.52) // top ~52%
      );

      const cropCanvas = createCanvas(cropW, cropH);
      const cropCtx = cropCanvas.getContext("2d");

      // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
      cropCtx.drawImage(
        fullCanvas as any,
        cropX,
        cropY,
        cropW,
        cropH,
        0,
        0,
        cropW,
        cropH
      );

      // Save cropped PNG
      const pngBuffer = cropCanvas.toBuffer("image/png");
      await fs.writeFile(tmpPng, pngBuffer);

      // 4) Upload PNG thumb
      await bucket.upload(tmpPng, {
        destination: thumbPath,
        metadata: {
          contentType: "image/png",
          cacheControl: "public, max-age=86400",
        },
      });

      logger.info("Thumbnail uploaded", { thumbPath });
    } finally {
      // cleanup temp files
      await Promise.allSettled([fs.unlink(tmpPdf), fs.unlink(tmpPng)]);
    }
  }
);

export const refillProspectMapSlot = onDocumentUpdated(
  {
    document: "prospects/{prospectId}",
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;

    const beforeStatus = before.status ?? "open";
    const afterStatus = after.status ?? "open";

    // only react if status changed
    if (beforeStatus === afterStatus) return;

    const hubId = after.hubId ?? before.hubId ?? "";
    if (!hubId) return;

    const wasVisible = before.showOnMap === true;
    const becameClosed = afterStatus === "dead" || afterStatus === "converted";

    // Only fill a hole if a visible lead was just removed from the map
    if (!wasVisible || !becameClosed) return;

    const db = getFirestore();

    try {
      // make sure the changed prospect is off the map
      if (after.showOnMap === true) {
        await event.data!.after.ref.set({ showOnMap: false }, { merge: true });
      }

      const replacementSnap = await db
        .collection("prospects")
        .where("hubId", "==", hubId)
        .where("hubEligible", "==", true)
        .where("status", "==", "open")
        .where("showOnMap", "==", false)
        .orderBy("hubRank")
        .limit(1)
        .get();

      if (replacementSnap.empty) {
        logger.info("No replacement prospect found", {
          hubId,
          removedProspectId: event.params.prospectId,
        });
        return;
      }

      const replacement = replacementSnap.docs[0];

      await replacement.ref.set({ showOnMap: true }, { merge: true });

      logger.info("Promoted replacement prospect", {
        hubId,
        removedProspectId: event.params.prospectId,
        replacementProspectId: replacement.id,
      });
    } catch (error) {
      logger.error("Failed to refill prospect map slot", {
        hubId,
        prospectId: event.params.prospectId,
        error,
      });
      throw error;
    }
  }
);

// ✅ scheduled cleanup for AI Product Finder