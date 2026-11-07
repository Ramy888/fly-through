# Book rest rooms for crews who have reached their duty limit away from base (one room per crew member, 6 per crew).
from _common import read_params, finish
p = read_params()
airport, crews = str(p["airport"])[:3], int(p["crews"])
if not 0 < crews <= 20:
    raise SystemExit("crews out of range")
rows = [["crew_slot", "airport", "rooms"]] + [[f"{airport}-crew-{i + 1}", airport, 6] for i in range(crews)]
finish(f"{crews * 6} crew rest rooms booked at {airport} for {crews} crews", rows, {"crews": crews})
