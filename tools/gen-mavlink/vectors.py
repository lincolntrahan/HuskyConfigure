"""Generate MAVLink test vectors with pymavlink (the reference implementation).

    python vectors.py > ../../packages/mavlink/test/vectors.json

Writes, for every ardupilotmega message, its CRC_EXTRA and lengths, plus encoded frames
(v1 and v2) for a set of messages the configurator depends on.
"""
import json
import os
import sys

os.environ["MAVLINK20"] = "1"
from pymavlink.dialects.v20 import ardupilotmega as m2  # noqa: E402
from pymavlink.dialects.v10 import ardupilotmega as m1  # noqa: E402


class Buf:
    def __init__(self):
        self.data = b""

    def write(self, b):
        self.data += b


def link(mod, sysid=1, compid=1):
    b = Buf()
    mav = mod.MAVLink(b, srcSystem=sysid, srcComponent=compid)
    return mav, b


catalog = {}
for msgid, cls in m2.mavlink_map.items():
    catalog[str(msgid)] = {
        "name": cls.msgname,
        "crcExtra": cls.crc_extra,
    }

# (name, kwargs). Values chosen to be exactly representable in float32.
cases = [
    ("heartbeat", dict(type=1, autopilot=3, base_mode=81, custom_mode=5, system_status=4, mavlink_version=3)),
    ("param_value", dict(param_id=b"SERVO3_FUNCTION", param_value=79.0, param_type=9, param_count=1320, param_index=1104)),
    ("param_value", dict(param_id=b"ARSPD_OFFSET_XY", param_value=-1.25, param_type=9, param_count=7, param_index=0)),
    ("param_set", dict(target_system=1, target_component=1, param_id=b"RC1_REVERSED", param_value=1.0, param_type=2)),
    ("command_long", dict(target_system=1, target_component=1, command=241, confirmation=0,
                          param1=0, param2=0, param3=0, param4=0, param5=1, param6=0, param7=0)),
    ("command_ack", dict(command=241, result=0, progress=0, result_param2=0, target_system=255, target_component=190)),
    ("command_ack", dict(command=400, result=4, progress=50, result_param2=-7, target_system=255, target_component=190)),
    ("sys_status", dict(onboard_control_sensors_present=0x1234567, onboard_control_sensors_enabled=0x7654321,
                        onboard_control_sensors_health=0xFFFFFFF, load=500, voltage_battery=12345, current_battery=-1,
                        battery_remaining=-1, drop_rate_comm=0, errors_comm=0, errors_count1=1, errors_count2=2,
                        errors_count3=3, errors_count4=4, onboard_control_sensors_present_extended=1,
                        onboard_control_sensors_enabled_extended=1, onboard_control_sensors_health_extended=0)),
    ("rc_channels", dict(time_boot_ms=123456, chancount=16, **{f"chan{i}_raw": 1000 + i * 50 for i in range(1, 19)}, rssi=200)),
    ("servo_output_raw", dict(time_usec=987654321, port=0, **{f"servo{i}_raw": 1100 + i * 10 for i in range(1, 17)})),
    ("attitude", dict(time_boot_ms=1000, roll=0.5, pitch=-0.25, yaw=3.0, rollspeed=0.125, pitchspeed=-0.0625, yawspeed=0)),
    ("statustext", dict(severity=6, text=b"ArduPlane V4.7.2 (fb773567)", id=0, chunk_seq=0)),
    ("named_value_float", dict(time_boot_ms=42, name=b"HSK", value=2.5)),
    ("autopilot_version", dict(capabilities=0xFFEE, flight_sw_version=0x04070200, middleware_sw_version=0,
                               os_sw_version=0, board_version=0x03E60000,
                               flight_custom_version=[0x66, 0x62, 0x37, 0x37, 0x33, 0x35, 0x36, 0x37],
                               middleware_custom_version=[0] * 8, os_custom_version=[1, 2, 3, 4, 5, 6, 7, 8],
                               vendor_id=0x1209, product_id=0x5741, uid=0x1122334455667788,
                               uid2=list(range(1, 19)))),
    ("esc_telemetry_1_to_4", dict(temperature=[30, 31, 0, 0], voltage=[1680, 0, 0, 0], current=[250, 0, 0, 0],
                                  totalcurrent=[12, 0, 0, 0], rpm=[11000, 0, 0, 0], count=[5, 0, 0, 0])),
    ("file_transfer_protocol", dict(target_network=0, target_system=1, target_component=1,
                                    payload=list(range(0, 120)) + [0] * 131)),
    ("gps_raw_int", dict(time_usec=1, fix_type=3, lat=476200000, lon=-1223490000, alt=50000, eph=120, epv=200,
                         vel=1500, cog=9000, satellites_visible=12, alt_ellipsoid=1, h_acc=2, v_acc=3,
                         vel_acc=4, hdg_acc=5, yaw=0)),
]


def norm(v):
    if isinstance(v, bytes):
        return v.decode("ascii")
    if isinstance(v, int) and abs(v) > 2**53:
        return {"bigint": str(v)}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


vectors = []
for name, kw in cases:
    for ver, mod in (("v2", m2), ("v1", m1)):
        msg_cls = getattr(mod, f"MAVLink_{name}_message", None)
        if msg_cls is None or (ver == "v1" and msg_cls.id > 255):
            continue
        mav, b = link(mod)
        mav.seq = 7
        args = kw
        msg = msg_cls(**{k: args.get(k, 0) for k in msg_cls.fieldnames})
        mav.send(msg)
        vectors.append({
            "name": msg_cls.msgname, "id": msg_cls.id, "version": ver,
            "fields": {k: norm(v) for k, v in args.items()},
            "hex": b.data.hex(),
        })

json.dump({"catalog": catalog, "vectors": vectors}, sys.stdout, indent=1)
