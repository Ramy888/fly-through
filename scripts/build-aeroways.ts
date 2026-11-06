// Converts an Overpass export (aeroway ways with geometry) into the GeoJSON the map draws when zoomed in.
// Data © OpenStreetMap contributors (ODbL). Usage: npx tsx scripts/build-aeroways.ts <overpass.json> public/data/aeroways.geojson
import { readFileSync, writeFileSync } from "node:fs";

type Way = { tags: { aeroway: string; width?: string }; geometry: { lat: number; lon: number }[] };

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: build-aeroways.ts <overpass.json> <out.geojson>");

const ways = (JSON.parse(readFileSync(input, "utf8")) as { elements: Way[] }).elements;
const round = (n: number) => Math.round(n * 1e5) / 1e5;
const AREA = new Set(["apron", "terminal"]);

const features = ways
  .filter((w) => w.geometry?.length >= 2)
  .map((w) => {
    const coords = w.geometry.map((p) => [round(p.lon), round(p.lat)]);
    const kind = w.tags.aeroway;
    const closed = coords.length > 3 && coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1];
    return {
      type: "Feature",
      properties: { kind, width: Number(w.tags.width) || (kind === "runway" ? 60 : 23) },
      geometry: AREA.has(kind) && closed ? { type: "Polygon", coordinates: [coords] } : { type: "LineString", coordinates: coords },
    };
  });

writeFileSync(output, JSON.stringify({ type: "FeatureCollection", features }));
const counts = features.reduce<Record<string, number>>((a, f) => ((a[f.properties.kind] = (a[f.properties.kind] ?? 0) + 1), a), {});
console.log(`wrote ${features.length} features`, counts);
