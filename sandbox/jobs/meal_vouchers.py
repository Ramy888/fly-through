# Issue one meal voucher per stranded guest, with unique codes (GCAA care: meals after a 2 h delay).
import hashlib
from _common import read_params, finish
p = read_params()
airport, guests = str(p["airport"])[:3], int(p["guests"])
if not 0 < guests <= 5000:
    raise SystemExit("guests out of range")
rows = [["voucher", "airport", "value_aed"]] + [[f"MV-{airport}-{hashlib.sha1(f'{airport}{i}'.encode()).hexdigest()[:6].upper()}", airport, 40] for i in range(guests)]
finish(f"{guests} meal vouchers issued at {airport}", rows, {"guests": guests})
