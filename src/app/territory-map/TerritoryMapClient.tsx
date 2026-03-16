"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Circle,
  useMapEvents,
} from "react-leaflet";
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
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { db } from "@/lib/firebase";

type CustomerLocation = {
  id: string;
  customerNo?: string;
  customerName?: string;
  salespersonNo?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat: number;
  lng: number;
};

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
  zip?: string;
  phone?: string;
  website?: string;
  status?: string;
  salespersonNo?: string;
  hubId?: string;
  hubRank?: number | null;
  hubScore?: number;
  hubEligible?: boolean;
  showOnMap?: boolean;
  leadCreated?: boolean;
  leadCreatedAt?: any;
  salesLeadId?: string;
  lat: number;
  lng: number;
};

type TerritoryHub = {
  id: string;
  salespersonNo?: string;
  clusterId?: string;
  hubName?: string;
  lat: number;
  lng: number;
  accountCount?: number;
  radiusMiles?: number;
  radiusMeters?: number;
};

type ActionState =
  | { id: string; type: "dead" | "converted" }
  | null;

const ACCOUNT_PIN_ZOOM = 9;

const greenIcon = new L.Icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconRetinaUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const blueIcon = new L.Icon({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

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

function createClusterCustomIcon(cluster: any, background: string) {
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
        background:${background};
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

function createHubIcon(accountCount?: number) {
  const count = accountCount ?? 0;

  let size = 30;
  if (count >= 5) size = 34;
  if (count >= 10) size = 38;
  if (count >= 20) size = 44;
  if (count >= 40) size = 50;

  return L.divIcon({
    html: `
      <div style="
        width:${size}px;
        height:${size}px;
        border-radius:9999px;
        background:#111827;
        border:3px solid #ffffff;
        box-shadow:0 2px 10px rgba(0,0,0,0.35);
        display:flex;
        align-items:center;
        justify-content:center;
        color:#ffffff;
        font-weight:800;
        font-size:${count >= 100 ? 12 : 14}px;
        line-height:1;
      ">
        ${count}
      </div>
    `,
    className: "hub-count-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
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

function getAccountScore(a: CustomerLocation) {
  let score = 0;
  if (cleanText(a.customerName)) score += 100;
  if (cleanText(a.address1)) score += 40;
  if (cleanText(a.city)) score += 10;
  if (cleanText(a.state)) score += 10;
  if (cleanText(a.zip)) score += 10;
  return score;
}

function dedupeAccounts(rows: CustomerLocation[]) {
  const kept: CustomerLocation[] = [];

  for (const row of rows) {
    let merged = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];
      const sameAddr =
        cleanText(existing.address1).toLowerCase() ===
          cleanText(row.address1).toLowerCase() &&
        cleanText(existing.city).toLowerCase() ===
          cleanText(row.city).toLowerCase() &&
        cleanText(existing.state).toLowerCase() ===
          cleanText(row.state).toLowerCase();

      const close = distanceMeters(existing, row) <= 35;

      if (sameAddr || close) {
        if (getAccountScore(row) > getAccountScore(existing)) {
          kept[i] = row;
        }
        merged = true;
        break;
      }
    }

    if (!merged) kept.push(row);
  }

  return kept;
}

function ZoomWatcher({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMapEvents({
    zoomend() {
      onZoomChange(map.getZoom());
    },
  });

  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);

  return null;
}

function actionPillStyle(background: string, color: string, border: string) {
  return {
    padding: "4px 8px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background,
    color,
    fontWeight: 600,
    fontSize: 12,
    lineHeight: 1.1,
    cursor: "pointer" as const,
    whiteSpace: "nowrap" as const,
  };
}

export default function TerritoryMapClient() {
  const router = useRouter();

  const [accounts, setAccounts] = useState<CustomerLocation[]>([]);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [hubs, setHubs] = useState<TerritoryHub[]>([]);
  const [showAccounts, setShowAccounts] = useState(true);
  const [showProspects, setShowProspects] = useState(true);
  const [zoom, setZoom] = useState(7);
  const [actionState, setActionState] = useState<ActionState>(null);

  useEffect(() => {
    const auth = getAuth();
    let unsubAccounts: (() => void) | null = null;
    let unsubHubs: (() => void) | null = null;
    let unsubProspects: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubAccounts) {
        unsubAccounts();
        unsubAccounts = null;
      }
      if (unsubHubs) {
        unsubHubs();
        unsubHubs = null;
      }
      if (unsubProspects) {
        unsubProspects();
        unsubProspects = null;
      }

      if (!user) {
        setAccounts([]);
        setHubs([]);
        setProspects([]);
        return;
      }

      const userDoc = await getDoc(doc(db, "users", user.uid));
      const userData: any = userDoc.data();
      const salesman = String(userData?.salesperson || "").trim();

      if (!salesman) {
        setAccounts([]);
        setHubs([]);
        setProspects([]);
        return;
      }

      const accountsQuery = query(
        collection(db, "customerLocations"),
        where("salespersonNo", "==", salesman),
        orderBy("customerName"),
        limit(2000)
      );

      unsubAccounts = onSnapshot(
        accountsQuery,
        (snap) => {
          const out: CustomerLocation[] = [];
          snap.forEach((d) => {
            const p: any = d.data();
            if (typeof p.lat === "number" && typeof p.lng === "number") {
              out.push({
                id: d.id,
                customerNo: p.customerNo,
                customerName: p.customerName,
                salespersonNo: p.salespersonNo,
                address1: p.address1,
                city: p.city,
                state: p.state,
                zip: p.zip,
                lat: p.lat,
                lng: p.lng,
              });
            }
          });
          setAccounts(dedupeAccounts(out));
        },
        (err) => console.error("customerLocations snapshot error:", err)
      );

      const hubsQuery = query(
        collection(db, "salesmanTerritoryHubs"),
        where("salespersonNo", "==", salesman),
        orderBy("accountCount", "desc"),
        limit(200)
      );

      unsubHubs = onSnapshot(
        hubsQuery,
        (snap) => {
          const out: TerritoryHub[] = [];
          snap.forEach((d) => {
            const p: any = d.data();
            if (typeof p.lat === "number" && typeof p.lng === "number") {
              out.push({
                id: d.id,
                salespersonNo: p.salespersonNo,
                clusterId: p.clusterId,
                hubName: p.hubName,
                lat: p.lat,
                lng: p.lng,
                accountCount: p.accountCount,
                radiusMiles: p.radiusMiles,
                radiusMeters: p.radiusMeters,
              });
            }
          });
          setHubs(out);
        },
        (err) => console.error("salesmanTerritoryHubs snapshot error:", err)
      );

      const prospectsQuery = query(
        collection(db, "prospects"),
        where("salespersonNo", "==", salesman),
        where("showOnMap", "==", true),
        where("status", "==", "open"),
        orderBy("hubRank"),
        limit(500)
      );

      unsubProspects = onSnapshot(
        prospectsQuery,
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
                zip: p.zip,
                phone: p.phone,
                website: p.website,
                status: p.status,
                salespersonNo: p.salespersonNo,
                hubId: p.hubId,
                hubRank: p.hubRank,
                hubScore: p.hubScore,
                hubEligible: p.hubEligible,
                showOnMap: p.showOnMap,
                leadCreated: p.leadCreated,
                leadCreatedAt: p.leadCreatedAt,
                salesLeadId: p.salesLeadId,
                lat: p.lat,
                lng: p.lng,
              });
            }
          });
          setProspects(out);
        },
        (err) => console.error("prospects snapshot error:", err)
      );
    });

    return () => {
      if (unsubAccounts) unsubAccounts();
      if (unsubHubs) unsubHubs();
      if (unsubProspects) unsubProspects();
      unsubAuth();
    };
  }, []);

  const center = useMemo<[number, number]>(() => {
    if (hubs.length) return [hubs[0].lat, hubs[0].lng];
    if (accounts.length) return [accounts[0].lat, accounts[0].lng];
    if (prospects.length) return [prospects[0].lat, prospects[0].lng];
    return [46.8772, -96.7898];
  }, [hubs, accounts, prospects]);

  const prospectClusterKey = useMemo(() => {
    return prospects
      .map((p) => p.id)
      .sort()
      .join("|");
  }, [prospects]);

  const showAccountPins = showAccounts && zoom >= ACCOUNT_PIN_ZOOM;
  const showHubCircles = showAccounts;

  const handleCreateLead = (p: Prospect, title: string) => {
    const params = new URLSearchParams({
      prospectId: p.id,
      customerName: title || "",
      address: p.address1 || "",
      city: p.city || "",
      state: p.state || "",
      zip: p.zip || "",
      phone: p.phone || "",
      storeType:
        cleanText(p.shop) ||
        cleanText(p.amenity) ||
        cleanText(p.store) ||
        "",
      website: p.website || "",
    });

    router.push(`/salesLeads?${params.toString()}`);
  };

  const handleOpenCreatedLead = (p: Prospect) => {
    if (!p.salesLeadId) return;
    router.push(
      `/salesLeads?leadId=${encodeURIComponent(p.salesLeadId)}&open=details`
    );
  };

  const handleDeadLead = async (p: Prospect) => {
    try {
      setActionState({ id: p.id, type: "dead" });
      await updateDoc(doc(db, "prospects", p.id), {
        status: "dead",
        updatedAt: serverTimestamp(),
      });
    } catch (err: any) {
      console.error("mark dead error:", err);
      alert(err?.message || "Error marking dead lead.");
      setActionState(null);
    }
  };

  const handleCreateAccount = async (p: Prospect) => {
    try {
      setActionState({ id: p.id, type: "converted" });
      await updateDoc(doc(db, "prospects", p.id), {
        status: "converted",
        updatedAt: serverTimestamp(),
      });
    } catch (err: any) {
      console.error("mark converted error:", err);
      alert(err?.message || "Error marking account created.");
      setActionState(null);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={() => setShowAccounts((v) => !v)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid #111827",
            background: showAccounts ? "#111827" : "#ffffff",
            color: showAccounts ? "#ffffff" : "#111827",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Accounts
        </button>

        <button
          onClick={() => setShowProspects((v) => !v)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid #111827",
            background: showProspects ? "#111827" : "#ffffff",
            color: showProspects ? "#ffffff" : "#111827",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Prospects
        </button>
      </div>

      <MapContainer
        center={center}
        zoom={7}
        scrollWheelZoom
        closePopupOnClick={true}
        style={{ height: "72vh", width: "100%" }}
      >
        <ZoomWatcher onZoomChange={setZoom} />

        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {showHubCircles &&
          hubs.map((hub) => (
            <Circle
              key={`hub-circle-${hub.id}`}
              center={[hub.lat, hub.lng]}
              radius={typeof hub.radiusMeters === "number" ? hub.radiusMeters : 0}
              interactive={false}
              pathOptions={{
                color: "#111827",
                weight: 2,
                fillColor: "#111827",
                fillOpacity: 0.06,
              }}
            />
          ))}

        {showHubCircles &&
          zoom < ACCOUNT_PIN_ZOOM &&
          hubs.map((hub) => (
            <Marker
              key={`hub-marker-${hub.id}`}
              position={[hub.lat, hub.lng]}
              icon={createHubIcon(hub.accountCount)}
              interactive={false}
            />
          ))}

        {showAccountPins && (
          <MarkerClusterGroup
            chunkedLoading
            showCoverageOnHover={false}
            maxClusterRadius={50}
            spiderfyOnMaxZoom
            zoomToBoundsOnClick
            disableClusteringAtZoom={10}
            iconCreateFunction={(cluster: any) =>
              createClusterCustomIcon(cluster, "#16a34a")
            }
          >
            {accounts.map((a) => {
              const addressLine = [a.address1, a.city, a.state, a.zip]
                .filter(Boolean)
                .join(", ");

              return (
                <Marker
                  key={`acct-${a.id}`}
                  position={[a.lat, a.lng]}
                  icon={greenIcon}
                >
                  <Popup>
                    <div style={{ fontWeight: 800 }}>
                      {a.customerName || "Account"}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      {addressLine}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      Salesman: {a.salespersonNo || "—"}
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MarkerClusterGroup>
        )}

        {showProspects && (
          <MarkerClusterGroup
            key={prospectClusterKey}
            chunkedLoading
            showCoverageOnHover={false}
            maxClusterRadius={50}
            spiderfyOnMaxZoom
            zoomToBoundsOnClick
            iconCreateFunction={(cluster: any) =>
              createClusterCustomIcon(cluster, "#d32f2f")
            }
          >
            {prospects.map((p) => {
              const title = getProspectDisplayName(p);
              const addressLine = [p.address1, p.city, p.state]
                .filter(Boolean)
                .join(", ");
              const busy = actionState?.id === p.id;
              const converting =
                actionState?.id === p.id && actionState?.type === "converted";

              return (
                <Marker
                  key={`pros-${p.id}`}
                  position={[p.lat, p.lng]}
                  icon={blueIcon}
                >
                  <Popup>
                    <div style={{ fontWeight: 800 }}>{title}</div>

                    {addressLine && addressLine !== title ? (
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {addressLine}
                      </div>
                    ) : null}

                    {p.phone ? (
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        {p.phone}
                      </div>
                    ) : null}

                    {p.website ? (
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        <a href={p.website} target="_blank" rel="noreferrer">
                          Website
                        </a>
                      </div>
                    ) : null}

                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      Rank: {p.hubRank ?? "—"}
                    </div>

                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      Score:{" "}
                      {typeof p.hubScore === "number"
                        ? p.hubScore.toFixed(2)
                        : "—"}
                    </div>

                    <div
                      style={{
                        marginTop: 12,
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {p.leadCreated && p.salesLeadId ? (
                        <button
                          onClick={() => handleOpenCreatedLead(p)}
                          style={actionPillStyle("#16a34a", "#ffffff", "#16a34a")}
                        >
                          Lead Created
                        </button>
                      ) : (
                        <button
                          onClick={() => handleCreateLead(p, title)}
                          disabled={busy}
                          style={actionPillStyle("#ffffff", "#111827", "#d1d5db")}
                        >
                          Create Lead
                        </button>
                      )}

                      <button
                        onClick={() => handleDeadLead(p)}
                        disabled={busy}
                        style={actionPillStyle("#ffffff", "#111827", "#d1d5db")}
                      >
                        Dead Lead
                      </button>

                      <button
                        onClick={() => handleCreateAccount(p)}
                        disabled={busy}
                        style={actionPillStyle("#ffffff", "#111827", "#d1d5db")}
                      >
                        {converting ? "Converted" : "Create Account"}
                      </button>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MarkerClusterGroup>
        )}
      </MapContainer>

      {showAccounts ? (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {zoom >= ACCOUNT_PIN_ZOOM
            ? `Showing account pins`
            : `Showing account hubs`}
        </div>
      ) : null}
    </div>
  );
}