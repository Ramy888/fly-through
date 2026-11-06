import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import { BitmapLayer, PathLayer, TextLayer } from "@deck.gl/layers";
import { AIRPORTS, type AirportId } from "../shared/geo.ts";
import type { Snapshot } from "../shared/types.ts";

// Below this zoom airports are 3D dioramas; at or above it, the real runway layout from OpenStreetMap.
const DETAIL_ZOOM = 9.5;
const BASE_ZOOM = 6.8;

// NASA GIBS Blue Marble (public domain, no key; native tiles stop at zoom 8) + OSM aeroways (ODbL).
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    bluemarble: {
      type: "raster",
      tiles: [
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
      ],
      tileSize: 256,
      maxzoom: 8,
      attribution: "Imagery: NASA Blue Marble (GIBS)",
    },
    aeroways: { type: "geojson", data: "/data/aeroways.geojson", attribution: "Airports © OpenStreetMap contributors" },
  },
  layers: [
    { id: "bluemarble", type: "raster", source: "bluemarble", paint: { "raster-saturation": -0.15, "raster-brightness-max": 0.85 } },
    {
      id: "apron", type: "fill", source: "aeroways", minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "kind"], "apron"], paint: { "fill-color": "#59606d", "fill-opacity": 0.9 },
    },
    {
      id: "taxiway", type: "line", source: "aeroways", minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "kind"], "taxiway"],
      paint: { "line-color": "#8b93a1", "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, 0.6, 15, 12] },
    },
    {
      id: "runway", type: "line", source: "aeroways", minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "kind"], "runway"],
      paint: { "line-color": "#262a31", "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, 2.5, 15, 45] },
    },
    {
      id: "runway-centre", type: "line", source: "aeroways", minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "kind"], "runway"],
      paint: { "line-color": "#f4f4f4", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 15, 1.5], "line-dasharray": [4, 3] },
    },
    {
      id: "terminal", type: "fill", source: "aeroways", minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "kind"], "terminal"], paint: { "fill-color": "#d9b26f", "fill-opacity": 0.95 },
    },
  ],
};

// One parked plane per diversion airport; the label carries the flight count.
const HEADING: Partial<Record<AirportId, number>> = { DWC: 30, SHJ: 120, AAN: 200, BAH: 80 };
type Parked = { at: AirportId; count: number; pax: number };

type Airport = (typeof AIRPORTS)[AirportId];

// A soft fog texture drawn once: many overlapping translucent blobs, densest in the middle.
function makeFogTexture(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const r = 40 + rand() * 120;
    const d = rand() ** 1.6 * 190; // most blobs near the centre
    const a = rand() * Math.PI * 2;
    const x = 256 + Math.cos(a) * d;
    const y = 256 + Math.sin(a) * d;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(236,240,244,0.20)");
    grad.addColorStop(1, "rgba(236,240,244,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
  }
  // Fade to nothing towards the edges so the bank never shows the texture's square border.
  const mask = g.createRadialGradient(256, 256, 120, 256, 256, 256);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = mask;
  g.fillRect(0, 0, 512, 512);
  return c;
}
let fogTexture: HTMLCanvasElement | null = null;

function fogBounds(now: number): [number, number, number, number] {
  const [x, y] = AIRPORTS.HUB.pos;
  const dx = Math.sin(now / 37) * 0.06;
  const dy = Math.cos(now / 53) * 0.04;
  return [x - 0.62 + dx, y - 0.48 + dy, x + 0.62 + dx, y + 0.48 + dy];
}

function buildLayers(zoom: number, snap: Snapshot | null) {
  // Keep models a constant size on screen: model metres scale with metres per pixel (smaller on phones).
  const k = 2 ** (BASE_ZOOM - zoom) * modelScale;
  const detail = zoom >= DETAIL_ZOOM;
  const parked: Parked[] = (snap?.diverted ?? []).map((d) => ({ at: d.airport, count: d.flights.length, pax: d.pax }));
  // Fog density follows hub visibility: 150 m = thick, 6 km = gone.
  const fog = snap ? Math.max(0, Math.min(1, (6000 - snap.visibilityM) / 5850)) : 0;
  // Buses after a human approves plan B: straight-line progress from the hub to each diversion airport.
  const ok = snap?.decision?.approved;
  const busPlan = ok ? snap!.decision!.plans.find((p) => p.id === ok.planId)?.buses ?? [] : [];
  const buses = busPlan.map((b, i) => {
    const from = AIRPORTS.HUB.pos;
    const to = AIRPORTS[b.to].pos;
    const f = Math.max(0, Math.min(1, (snap!.now - ok!.at) / b.minutes));
    // fan parallel routes apart a little so two buses to the same airport don't overlap
    const off = (i % 2 ? 1 : -1) * 0.04 * Math.floor((i + 1) / 2);
    return { ...b, path: [from, [to[0] + off, to[1] - off]] as [number, number][], pos: [from[0] + (to[0] + off - from[0]) * f, from[1] + (to[1] - off - from[1]) * f] as [number, number], f, eta: Math.max(0, Math.round(ok!.at + b.minutes - snap!.now)) };
  });
  return [
    new PathLayer<(typeof buses)[number]>({
      id: "bus-routes",
      data: buses,
      getPath: (d) => d.path,
      getColor: [46, 196, 182, 220],
      getWidth: 4,
      widthUnits: "pixels",
      capRounded: true,
    }),
    new ScenegraphLayer<(typeof buses)[number]>({
      id: "buses",
      data: buses,
      scenegraph: "/models/minibus.glb",
      getPosition: (d) => [...d.pos, 300 * k] as [number, number, number],
      getOrientation: (d) => [0, (Math.atan2(d.path[1][0] - d.path[0][0], d.path[1][1] - d.path[0][1]) * 180) / Math.PI, 90],
      sizeScale: 9000 * k,
      _lighting: "pbr",
      updateTriggers: { getPosition: snap?.now },
    }),
    new TextLayer<(typeof buses)[number]>({
      id: "bus-labels",
      data: buses.filter((b) => b.f < 1),
      getPosition: (d) => d.pos,
      getText: (d) => `${d.crew} → ${d.to} · ${d.eta} min`,
      getSize: 13,
      getColor: [46, 196, 182, 255],
      // to the left of the bus, clear of the airport labels, and stacked because the buses leave the hub together
      getTextAnchor: "end",
      getPixelOffset: (_d, { index }) => [-34, -14 - 22 * index],
      fontFamily: "Inter, sans-serif",
      fontWeight: 600,
      characterSet: "auto",
      background: true,
      getBackgroundColor: [11, 20, 38, 200],
      backgroundPadding: [5, 2],
      updateTriggers: { getText: snap?.now, getPosition: snap?.now },
    }),
    new BitmapLayer({
      id: "fog",
      image: (fogTexture ??= makeFogTexture()),
      // The fog bank drifts slowly with sim time and thins as visibility recovers.
      bounds: fogBounds(snap?.now ?? 0),
      opacity: 0.95 * fog,
      visible: fog > 0.02,
      // The fog lies on the ground like the flat airport bases; without this it wins the depth test and hides the hub's base.
      parameters: { depthWriteEnabled: false, depthCompare: "always" },
    }),
    new ScenegraphLayer<Airport>({
      id: "airport-bases",
      data: Object.values(AIRPORTS),
      scenegraph: "/models/airport-base.glb",
      getPosition: (d) => d.pos,
      getOrientation: [0, -20, 90],
      sizeScale: 21000 * k,
      visible: !detail,
      // PBR shading turns the model's flat white apron black at this camera angle.
      _lighting: "flat",
    }),
    new ScenegraphLayer<Airport>({
      id: "tower",
      data: [AIRPORTS.HUB],
      scenegraph: "/models/tower.glb",
      getPosition: (d) => d.pos,
      getOrientation: [0, 0, 90],
      sizeScale: 26000 * k,
      _lighting: "pbr",
    }),
    new ScenegraphLayer<Parked>({
      id: "planes",
      data: parked,
      scenegraph: "/models/airliner.glb",
      getPosition: (d) => [...AIRPORTS[d.at].pos, detail ? 0 : 1800 * k] as [number, number, number],
      getOrientation: (d) => [0, HEADING[d.at] ?? 0, 90],
      sizeScale: (detail ? 9000 : 24000) * k,
      _lighting: "pbr",
    }),
    new TextLayer<Airport>({
      id: "airport-labels",
      data: Object.values(AIRPORTS),
      getPosition: (d) => d.pos,
      getText: (d) => {
        const p = parked.find((x) => AIRPORTS[x.at] === d);
        return p ? `${d.code} · ${p.count} diverted` : d.code;
      },
      updateTriggers: { getText: parked.map((p) => p.count).join() },
      getSize: 16,
      getColor: [255, 255, 255, 235],
      getPixelOffset: [0, -48],
      fontFamily: "Inter, sans-serif",
      fontWeight: 600,
      characterSet: "auto",
      background: true,
      getBackgroundColor: [11, 20, 38, 190],
      backgroundPadding: [6, 3],
    }),
  ];
}

// The UAE airports, where the buses run, with a margin for labels. Bahrain (no road) shows when there is room;
// fitting it too would zoom out until the fixed-size airport models pile on top of each other.
const UAE = (["HUB", "DWC", "SHJ", "AAN"] as const).map((id) => AIRPORTS[id].pos);
const AIRPORT_BOUNDS: [[number, number], [number, number]] = [
  [Math.min(...UAE.map((p) => p[0])) - 0.5, Math.min(...UAE.map((p) => p[1])) - 0.2],
  [Math.max(...UAE.map((p) => p[0])) + 0.3, Math.max(...UAE.map((p) => p[1])) + 0.3],
];
const FIT_ZOOM: [number, number] = [7.0, 7.8]; // below 7 the models overlap; above 7.8 the scene feels cramped
// Phones: the map is narrow, so zoom out further and draw the models smaller to keep the airports apart.
const PHONE_FIT_ZOOM: [number, number] = [5.8, 7.8];
let modelScale = 1;

/** `leftInset` is the width the left chat panel covers; the camera keeps every airport clear of it and of the other panels. */
export function GulfMap({ snap, leftInset }: { snap: Snapshot | null; leftInset: number }) {
  const el = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const insetRef = useRef(leftInset);
  insetRef.current = leftInset;

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      center: [53.5, 25.05],
      zoom: BASE_ZOOM,
      pitch: 52,
      bearing: -12,
      maxZoom: 15,
      attributionControl: { compact: true },
    });
    fit(map, insetRef.current, false);
    map.on("resize", () => fit(map, insetRef.current, false));
    const overlay = new MapboxOverlay({ interleaved: false, layers: buildLayers(map.getZoom(), snapRef.current) });
    map.addControl(overlay as unknown as maplibregl.IControl);
    map.on("zoom", () => overlay.setProps({ layers: buildLayers(map.getZoom(), snapRef.current) }));
    overlayRef.current = overlay;
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = map;
    return () => map.remove();
  }, []);

  useEffect(() => {
    if (mapRef.current) fit(mapRef.current, leftInset, true);
  }, [leftInset]);

  useEffect(() => {
    if (overlayRef.current && mapRef.current) overlayRef.current.setProps({ layers: buildLayers(mapRef.current.getZoom(), snap) });
  }, [snap]);

  return <div ref={el} className="map" />;
}

/** Frame the airports in the space left between the top bar, the side panels and the subtitle. */
function fit(map: maplibregl.Map, leftInset: number, animate: boolean) {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const side = Math.min(1, (w - 240) / (leftInset + 40 + 440)); // shrink the side padding on narrow screens so a fit is always possible
  const vert = Math.min(1, (h - 160) / 280);
  // Phones stack the panels below the map, so nothing covers it.
  const stacked = window.innerWidth < 1024;
  const padding = stacked ? { top: 40, bottom: 30, left: Math.min(120, w / 4), right: 30 } : { top: 90 * vert, bottom: 170 * vert, left: (leftInset + 40) * side, right: 440 * side };
  const cam = map.cameraForBounds(AIRPORT_BOUNDS, { padding, bearing: -12 });
  if (!cam) return;
  const [lo, hi] = stacked ? PHONE_FIT_ZOOM : FIT_ZOOM;
  modelScale = stacked ? Math.max(0.5, Math.min(1, w / 1000)) : 1;
  const zoom = Math.max(lo, Math.min(hi, cam.zoom ?? BASE_ZOOM));
  map.easeTo({ center: cam.center, zoom, bearing: -12, pitch: 52, duration: animate ? 600 : 0 });
}
