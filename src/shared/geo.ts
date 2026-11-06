// Airports used by the fog scenario. [lng, lat] order, as MapLibre and deck.gl expect.
export const AIRPORTS = {
  HUB: { code: "AUH", name: "Hub", pos: [54.6511, 24.4330] as [number, number] },
  DWC: { code: "DWC", name: "Dubai World Central", pos: [55.1614, 24.8960] as [number, number] },
  SHJ: { code: "SHJ", name: "Sharjah", pos: [55.5172, 25.3286] as [number, number] },
  AAN: { code: "AAN", name: "Al Ain", pos: [55.6092, 24.2617] as [number, number] },
  BAH: { code: "BAH", name: "Bahrain", pos: [50.6336, 26.2708] as [number, number] },
} as const;

export type AirportId = keyof typeof AIRPORTS;
