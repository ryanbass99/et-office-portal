"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";

import { db } from "@/lib/firebase";

const DefaultIcon = L.icon({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

type Prospect = {
  id: string;
  name?: string;
  brand?: string;
  operator?: string;
  shop?: string;
  store?: string;
  amenity?: string;
  tourism?: string;
  leisure?: string;
  building?: string;
  display_name?: string;
  address1?: string;
  city?: string;
  state?: string;
  phone?: string;
  website?: string;
  lat: number;
  lng: number;
  status?: string;
};

const BAD_NAMES = new Set([
  "",
  "(unnamed)",
  "unnamed",
  "unknown",
  "unknown prospect",
]);

function cleanText(v?: string) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (BAD_NAMES.has(s.toLowerCase())) return "";
  return s;
}

function getProspectDisplayName(p: Prospect) {
  const cityState = [cleanText(p.city), cleanText(p.state)]
    .filter(Boolean)
    .join(", ");

  return (
    cleanText(p.name) ||
    cleanText(p.brand) ||
    cleanText(p.operator) ||
    cleanText(p.shop) ||
    cleanText(p.store) ||
    cleanText(p.amenity) ||
    cleanText(p.tourism) ||
    cleanText(p.leisure) ||
    cleanText(p.building) ||
    cleanText(p.display_name) ||
    cleanText(p.address1) ||
    cityState ||
    "Unknown Prospect"
  );
}

function hasRealBusinessName(p: Prospect) {
  return Boolean(
    cleanText(p.name) ||
      cleanText(p.brand) ||
      cleanText(p.operator) ||
      cleanText(p.shop) ||
      cleanText(p.store)
  );
}

function getProspectScore(p: Prospect) {
  let score = 0;

  if (cleanText(p.name)) score += 1000;
  if (cleanText(p.brand)) score += 300;
  if (cleanText(p.operator)) score += 200;
  if (cleanText(p.shop)) score += 120;
  if (cleanText(p.store)) score += 100;

  if (cleanText(p.amenity)) score += 40;
  if (cleanText(p.tourism)) score += 20;
  if (cleanText(p.leisure)) score += 20;
  if (cleanText(p.building)) score += 10;

  if (cleanText(p.address1)) score += 25;
  if (cleanText(p.phone)) score += 10;
  if (cleanText(p.website)) score += 10;

  const title = getProspectDisplayName(p).toLowerCase();
  if (title === "unknown prospect") score -= 500;
  if (title === `${(p.city || "").trim().toLowerCase()}, ${(p.state || "")
    .trim()
    .toLowerCase()}`) {
    score -= 200;
  }

  return score;
}

function distanceMeters(a: Prospect, b: Prospect) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function shouldMerge(a: Prospect, b: Prospect) {
  const dist = distanceMeters(a, b);

  const aAddr = cleanText(a.address1).toLowerCase();
  const bAddr = cleanText(b.address1).toLowerCase();

  if (aAddr && bAddr && aAddr === bAddr && dist <= 80) return true;

  const aCity = cleanText(a.city).toLowerCase();
  const bCity = cleanText(b.city).toLowerCase();

  if (aCity && bCity && aCity === bCity && dist <= 35) return true;

  return false;
}

function dedupeProspects(rows: Prospect[]) {
  const kept: Prospect[] = [];

  for (const p of rows) {
    let merged = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];

      if (!shouldMerge(existing, p)) continue;

      const existingHasName = hasRealBusinessName(existing);
      const nextHasName = hasRealBusinessName(p);

      if (nextHasName && !existingHasName) {
        kept[i] = p;
      } else if (nextHasName === existingHasName) {
        if (getProspectScore(p) > getProspectScore(existing)) {
          kept[i] = p;
        }
      }

      merged = true;
      break;
    }

    if (!merged) kept.push(p);
  }

  return kept;
}

function createClusterCustomIcon(cluster: any) {
  const count = cluster.getChildCount();

  let size = 38;
  if (count >= 10) size = 44;
  if (count >= 25) size = 52;
  if (count >= 50) size = 60;

  return L.divIcon({
    html: `
      <div style="
        width:${size}px;
        height:${size}px;
        border-radius:9999px;
        background:#d32f2f;
        border:4px solid #ffffff;
        box-shadow:0 2px 10px rgba(0,0,0,0.28);
        display:flex;
        align-items:center;
        justify-content:center;
        color:#ffffff;
        font-weight:800;
        font-size:${count >= 100 ? 14 : 16}px;
      ">
        ${count}
      </div>
    `,
    className: "custom-marker-cluster",
    iconSize: L.point(size, size, true),
  });
}

export default function ProspectMapClient() {
  const [rows, setRows] = useState<Prospect[]>([]);

  useEffect(() => {
    const q = query(
      collection(db, "prospects"),
      where("lat", "!=", null),
      orderBy("lat"),
      limit(500)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const out: Prospect[] = [];

        snap.forEach((d) => {
          const p: any = d.data();

          if (typeof p.lat === "number" && typeof p.lng === "number") {
            out.push({
              id: d.id,
              name: p.name,
              brand: p.brand,
              operator: p.operator,
              shop: p.shop,
              store: p.store,
              amenity: p.amenity,
              tourism: p.tourism,
              leisure: p.leisure,
              building: p.building,
              display_name: p.display_name,
              address1: p.address1,
              city: p.city,
              state: p.state,
              phone: p.phone,
              website: p.website,
              lat: p.lat,
              lng: p.lng,
              status: p.status,
            });
          }
        });

        setRows(dedupeProspects(out));
      },
      (err) => {
        console.error("Prospects map snapshot error:", err);
      }
    );

    return () => unsub();
  }, []);

  const center = useMemo<[number, number]>(() => {
    if (rows.length) return [rows[0].lat, rows[0].lng];
    return [41.873618, -94.677667];
  }, [rows]);

  return (
    <div style={{ height: "100%", width: "100%" }}>
      <MapContainer
        center={center}
        zoom={10}
        scrollWheelZoom
        style={{ height: "72vh", width: "100%" }}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MarkerClusterGroup
          chunkedLoading
          showCoverageOnHover={false}
          maxClusterRadius={50}
          spiderfyOnMaxZoom
          zoomToBoundsOnClick
          iconCreateFunction={createClusterCustomIcon}
        >
          {rows.map((p) => {
            const title = getProspectDisplayName(p);
            const addressLine = [p.address1, p.city, p.state]
              .filter(Boolean)
              .join(", ");

            return (
              <Marker key={p.id} position={[p.lat, p.lng]} icon={DefaultIcon}>
                <Popup>
                  <div style={{ fontWeight: 800 }}>{title}</div>

                  {addressLine && addressLine !== title ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {addressLine}
                    </div>
                  ) : null}

                  {p.phone ? (
                    <div style={{ marginTop: 6, fontSize: 12 }}>{p.phone}</div>
                  ) : null}

                  {p.website ? (
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      <a href={p.website} target="_blank" rel="noreferrer">
                        Website
                      </a>
                    </div>
                  ) : null}
                </Popup>
              </Marker>
            );
          })}
        </MarkerClusterGroup>
      </MapContainer>
    </div>
  );
}