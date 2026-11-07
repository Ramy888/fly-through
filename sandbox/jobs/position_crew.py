# Plan a positioning trip for a fresh crew to an airport with no road from the hub: road to DXB, then a commercial flight.
from _common import read_params, finish
p = read_params()
airport, now = str(p["airport"])[:3], int(p["now"])
if airport != "BAH":
    raise SystemExit("positioning flights are only for airports without a road")
legs = [("road", "HUB", "DXB", 75), ("check-in and boarding", "DXB", "DXB", 45), ("flight", "DXB", "BAH", 80)]
rows, t = [["leg", "from", "to", "departs", "arrives"]], now
for kind, a, b, mins in legs:
    rows.append([kind, a, b, f"{t // 60:02d}:{t % 60:02d}", f"{(t + mins) // 60:02d}:{(t + mins) % 60:02d}"])
    t += mins
finish(f"fresh crew reaches {airport} at {t // 60:02d}:{t % 60:02d} ({len(legs)} legs)", rows, {"ready_at": t})
