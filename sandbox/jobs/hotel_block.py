# Allocate guests from diverted flights to hotel rooms near the airport (two guests per room, families together).
from _common import read_params, finish
p = read_params()
airport, guests = str(p["airport"])[:3], int(p["guests"])
if not 0 < guests <= 5000:
    raise SystemExit("guests out of range")
hotels = [("Airport Hotel", 0.45), ("City Inn", 0.35), ("Transit Suites", 0.20)]
rows, left = [["hotel", "airport", "guests", "rooms"]], guests
for i, (name, share) in enumerate(hotels):
    n = left if i == len(hotels) - 1 else round(guests * share)
    left -= n
    rows.append([name, airport, n, (n + 1) // 2])
rooms = sum(r[3] for r in rows[1:])
finish(f"{guests} guests in {rooms} rooms across {len(hotels)} hotels near {airport}", rows, {"guests": guests, "rooms": rooms})
